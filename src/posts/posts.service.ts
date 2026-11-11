import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { OpenAiService } from '../ai/openai.service';
import { CoachService } from '../coach/coach.service';
import { AuthUser } from '../common/auth.decorators';
import { clampLimit, decodeCursor, encodeCursor } from '../common/cursor';
import {
  categoryFromLabel,
  POST_SELECT,
  PostRow,
  toAuthor,
  toFeedPost,
} from '../common/mappers';
import { TtlCache } from '../common/ttl-cache';
import { Prisma } from '../generated/prisma/client';
import { MediaType, PublishMode } from '../generated/prisma/enums';
import { JobsService } from '../jobs/jobs.service';
import { StorageService } from '../media/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';
import { PostLifecycleService } from './post-lifecycle.service';
import {
  ALLOWED_MIME,
  MAX_DAILY_UPLOADS,
  MAX_PENDING_UPLOADS,
  MAX_UPLOAD_BYTES,
} from './posts.constants';
import {
  CommentDto,
  InitUploadDto,
  PostDetailsDto,
  ReportDto,
  SubmitPostDto,
} from './posts.dto';
import { SocialService } from './social.service';

const MODES: Record<SubmitPostDto['mode'], PublishMode> = {
  public: 'PUBLIC',
  draft: 'DRAFT',
  ai: 'AI',
};

@Injectable()
export class PostsService {
  private readonly logger = new Logger('Posts');
  /** Un partage compté au plus une fois par heure et par personne. */
  private readonly recentShares = new TtlCache<true>(60 * 60_000, 50_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly social: SocialService,
    private readonly lifecycle: PostLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly progress: ProgressService,
    private readonly openai: OpenAiService,
    private readonly coach: CoachService,
  ) {}

  /** Les alertes partent en arrière-plan : elles ne ralentissent jamais la réponse. */
  private background(promise: Promise<unknown>) {
    promise.catch((e: Error) =>
      this.logger.warn(`Tâche de fond : ${e.message}`),
    );
  }

  /* ---------- Envoi ---------- */

  /** Étape 1 : réserve un post et renvoie une URL d'envoi direct vers R2. */
  async initUpload(user: AuthUser, dto: InitUploadDto) {
    const type: MediaType = dto.type === 'video' ? 'VIDEO' : 'AUDIO';
    const mime = dto.mimeType.toLowerCase().split(';')[0].trim();
    const ext = ALLOWED_MIME[type][mime];
    if (!ext)
      throw new BadRequestException({
        code: 'UNSUPPORTED_FORMAT',
        message: 'Format de fichier non pris en charge',
      });
    if (dto.sizeBytes > MAX_UPLOAD_BYTES[type]) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'Fichier trop volumineux',
      });
    }
    if (dto.duration > 61)
      throw new BadRequestException({
        code: 'TOO_LONG',
        message: 'Durée maximale : 1 minute',
      });

    const today = await this.prisma.post.count({
      where: {
        authorId: user.id,
        createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
      },
    });
    if (today >= MAX_DAILY_UPLOADS) {
      throw new HttpException(
        {
          code: 'DAILY_LIMIT',
          message: 'Limite d’envois atteinte pour aujourd’hui',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const pending = await this.prisma.post.count({
      where: { authorId: user.id, status: 'UPLOADING' },
    });
    if (pending >= MAX_PENDING_UPLOADS) {
      throw new ConflictException({
        code: 'TOO_MANY_UPLOADS',
        message: 'Termine tes envois en cours avant d’en commencer un autre',
      });
    }

    const mediaPrefix = `p/${randomBytes(16).toString('hex')}`;
    const rawKey = `${mediaPrefix}/raw.${ext}`;
    const post = await this.prisma.post.create({
      data: {
        authorId: user.id,
        type,
        mode: 'DRAFT',
        mediaPrefix,
        rawKey,
        rawMime: mime,
        duration: dto.duration,
      },
      select: { id: true },
    });
    const uploadUrl = await this.storage.presignUpload(
      rawKey,
      mime,
      dto.sizeBytes,
    );
    return {
      postId: post.id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      expiresIn: 600,
    };
  }

  /** Étape 2 : l'app a fini l'envoi → détails + lancement du traitement. */
  async submit(user: AuthUser, postId: string, dto: SubmitPostDto) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.authorId !== user.id)
      throw new NotFoundException('Post introuvable');
    if (post.status !== 'UPLOADING' || !post.rawKey)
      throw new ConflictException('Ce post a déjà été envoyé');

    const head = await this.storage.head(post.rawKey);
    if (!head)
      throw new BadRequestException({
        code: 'UPLOAD_MISSING',
        message: 'Le fichier n’a pas été reçu',
      });
    if (head.size > MAX_UPLOAD_BYTES[post.type]) {
      await this.storage.deleteKeys([post.rawKey]);
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'Fichier trop volumineux',
      });
    }

    const mode = MODES[dto.mode];
    let themeId: string | null = null;
    if (mode === 'PUBLIC' && dto.joinTheme) {
      const theme = await this.prisma.theme.findFirst({
        where: dto.themeId
          ? { id: dto.themeId, status: 'ACTIVE' }
          : { status: 'ACTIVE', period: 'WEEKLY' },
        select: { id: true },
      });
      if (!theme)
        throw new BadRequestException({
          code: 'THEME_CLOSED',
          message: 'Ce thème est terminé',
        });
      themeId = theme.id;
    }

    await this.assertCleanText(
      user.id,
      [dto.title, ...(dto.hashtags ?? [])].filter(Boolean).join(' '),
    );

    // Mode coach IA : le quota est vérifié et réservé avant tout traitement.
    if (mode === 'AI') await this.coach.reserve(user, postId);

    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'PROCESSING',
        mode,
        themeId,
        title: dto.title ?? '',
        category: dto.category ? categoryFromLabel(dto.category) : null,
        hashtags: dto.hashtags ?? [],
      },
    });
    await this.jobs.enqueue('media.process', { postId });
    return { postId, status: 'processing' };
  }

  /** Suivi du traitement (l'app interroge cette route après l'envoi). */
  async status(userId: string, postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        authorId: true,
        status: true,
        moderationReason: true,
        processingError: true,
      },
    });
    if (!post || post.authorId !== userId)
      throw new NotFoundException('Post introuvable');
    return {
      status: post.status.toLowerCase(),
      message: post.processingError ?? post.moderationReason ?? undefined,
    };
  }

  private async assertCleanText(userId: string, text: string) {
    if (!text.trim()) return;
    const verdict = await this.openai.moderate({ text });
    if (verdict.flagged) {
      this.logger.warn(
        `Texte refusé pour ${userId} : ${verdict.categories.join(', ')}`,
      );
      throw new UnprocessableEntityException({
        code: 'CONTENT_REJECTED',
        message: 'Ce texte ne respecte pas les règles de la communauté',
      });
    }
  }

  /* ---------- Lecture & édition ---------- */

  private async loadPost(id: string) {
    return (await this.prisma.post.findUnique({
      where: { id },
      select: POST_SELECT,
    })) as PostRow | null;
  }

  /** Post visible par le lecteur : publié et auteur non bloqué, ou le sien. */
  private async visiblePost(viewerId: string, postId: string) {
    const post = await this.loadPost(postId);
    if (!post) throw new NotFoundException('Post introuvable');
    if (post.author.id === viewerId) return post;
    if (
      post.status !== 'PUBLISHED' ||
      (await this.social.isHidden(viewerId, post.author.id))
    ) {
      throw new NotFoundException('Post introuvable');
    }
    return post;
  }

  async get(viewerId: string, postId: string) {
    const post = await this.loadPost(postId);
    if (!post) throw new NotFoundException('Post introuvable');
    const isOwner = post.author.id === viewerId;
    if (!isOwner && (await this.social.isHidden(viewerId, post.author.id)))
      throw new NotFoundException('Post introuvable');
    if (!isOwner && post.status !== 'PUBLISHED') {
      // L'app affiche un état « indisponible » plutôt qu'une erreur.
      if (post.status === 'REMOVED' || post.status === 'REJECTED') {
        const hidden = {
          ...post,
          mediaKey: null,
          thumbnailKey: null,
          transcript: null,
          title: '',
          hashtags: [],
        };
        return {
          ...toFeedPost(hidden, this.emptyViewer()),
          thumbnailUrl: '',
          status: 'removed',
        };
      }
      throw new NotFoundException('Post introuvable');
    }
    const viewer = (await this.social.viewerStates(viewerId, [post])).get(
      post.id,
    )!;
    return toFeedPost(post, viewer);
  }

  private emptyViewer() {
    return {
      isLiked: false,
      isSaved: false,
      isConvinced: false,
      isFollowingAuthor: false,
    };
  }

  async update(userId: string, postId: string, dto: PostDetailsDto) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, status: true },
    });
    if (!post || post.authorId !== userId)
      throw new NotFoundException('Post introuvable');
    if (['UPLOADING', 'REMOVED', 'REJECTED'].includes(post.status))
      throw new ForbiddenException('Ce post ne peut pas être modifié');
    await this.assertCleanText(
      userId,
      [dto.title, ...(dto.hashtags ?? [])].filter(Boolean).join(' '),
    );
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        title: dto.title,
        category: dto.category ? categoryFromLabel(dto.category) : undefined,
        hashtags: dto.hashtags,
      },
    });
    return this.get(userId, postId);
  }

  /** Publie un brouillon (ou une prise faite pour le coach IA). */
  async publish(userId: string, postId: string, joinTheme?: boolean) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, status: true, moderationReason: true },
    });
    if (!post || post.authorId !== userId)
      throw new NotFoundException('Post introuvable');
    if (post.status !== 'DRAFT' && post.status !== 'PRIVATE')
      throw new ConflictException('Ce post n’est pas un brouillon');
    if (post.moderationReason) {
      throw new ForbiddenException({
        code: 'CONTENT_REJECTED',
        message: 'Ce contenu ne respecte pas les règles de la communauté',
      });
    }
    const theme = joinTheme
      ? await this.prisma.theme.findFirst({
          where: { status: 'ACTIVE', period: 'WEEKLY' },
          select: { id: true },
        })
      : null;

    const { count } = await this.prisma.post.updateMany({
      where: { id: postId, status: post.status },
      data: {
        status: 'PUBLISHED',
        mode: 'PUBLIC',
        publishedAt: new Date(),
        themeId: theme?.id ?? null,
      },
    });
    if (count) await this.lifecycle.onPublished(postId);
    return this.get(userId, postId);
  }

  async remove(user: AuthUser, postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, status: true, mediaPrefix: true },
    });
    if (!post || post.authorId !== user.id)
      throw new NotFoundException('Post introuvable');
    if (post.status === 'PROCESSING')
      throw new ConflictException(
        'Attends la fin du traitement pour supprimer ce post',
      );

    await this.prisma.$transaction(async (tx) => {
      // Compteurs des personnes ayant interagi avec ce post.
      await tx.$executeRaw`
        UPDATE "User" u SET "convincedTotal" = GREATEST(0, u."convincedTotal" - p."convincedCount")
        FROM "Post" p WHERE p."id" = ${postId}::uuid AND u."id" = p."authorId"`;
      await tx.post.delete({ where: { id: postId } });
    });
    if (post.status === 'PUBLISHED')
      await this.lifecycle.onUnpublished(postId, post.authorId);
    await this.lifecycle.deleteMedia(post.mediaPrefix);
    return { ok: true };
  }

  /* ---------- Interactions ---------- */

  async setLike(userId: string, postId: string, on: boolean) {
    const post = await this.visiblePost(userId, postId);
    if (on) {
      const { count } = await this.prisma.like.createMany({
        data: [{ userId, postId }],
        skipDuplicates: true,
      });
      if (count) {
        await this.prisma.post.update({
          where: { id: postId },
          data: { likesCount: { increment: 1 } },
        });
        this.background(
          this.notifications.notify({
            userId: post.author.id,
            type: 'LIKE',
            actorId: userId,
            postId,
          }),
        );
      }
    } else {
      const { count } = await this.prisma.like.deleteMany({
        where: { userId, postId },
      });
      if (count) {
        await this.prisma.post.updateMany({
          where: { id: postId, likesCount: { gt: 0 } },
          data: { likesCount: { decrement: 1 } },
        });
      }
    }
    return { liked: on };
  }

  async setSave(userId: string, postId: string, on: boolean) {
    await this.visiblePost(userId, postId);
    if (on) {
      const { count } = await this.prisma.save.createMany({
        data: [{ userId, postId }],
        skipDuplicates: true,
      });
      if (count)
        await this.prisma.post.update({
          where: { id: postId },
          data: { savesCount: { increment: 1 } },
        });
    } else {
      const { count } = await this.prisma.save.deleteMany({
        where: { userId, postId },
      });
      if (count) {
        await this.prisma.post.updateMany({
          where: { id: postId, savesCount: { gt: 0 } },
          data: { savesCount: { decrement: 1 } },
        });
      }
    }
    return { saved: on };
  }

  /** Vote « Convaincu » : uniquement sur un post d'un thème en cours, et pas le sien. */
  async setConvinced(userId: string, postId: string, on: boolean) {
    const post = await this.visiblePost(userId, postId);
    if (post.author.id === userId)
      throw new ForbiddenException('Tu ne peux pas voter pour toi-même');
    if (!post.theme || post.theme.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'VOTE_CLOSED',
        message: 'Le vote est fermé pour ce post',
      });
    }
    if (on) {
      const { count } = await this.prisma.convinced.createMany({
        data: [{ userId, postId }],
        skipDuplicates: true,
      });
      if (count) {
        const [, author] = await this.prisma.$transaction([
          this.prisma.post.update({
            where: { id: postId },
            data: { convincedCount: { increment: 1 } },
          }),
          this.prisma.user.update({
            where: { id: post.author.id },
            data: { convincedTotal: { increment: 1 } },
            select: { convincedTotal: true },
          }),
        ]);
        this.background(
          this.notifications.notify({
            userId: post.author.id,
            type: 'CONVINCED',
            actorId: userId,
            postId,
          }),
        );
        if (author.convincedTotal >= 100)
          this.background(this.progress.award(post.author.id, 'convince'));
      }
    } else {
      const { count } = await this.prisma.convinced.deleteMany({
        where: { userId, postId },
      });
      if (count) {
        await this.prisma.$transaction([
          this.prisma.post.updateMany({
            where: { id: postId, convincedCount: { gt: 0 } },
            data: { convincedCount: { decrement: 1 } },
          }),
          this.prisma.user.updateMany({
            where: { id: post.author.id, convincedTotal: { gt: 0 } },
            data: { convincedTotal: { decrement: 1 } },
          }),
        ]);
      }
    }
    return { convinced: on };
  }

  async share(userId: string, postId: string) {
    await this.visiblePost(userId, postId);
    const key = `${userId}:${postId}`;
    if (!this.recentShares.get(key)) {
      this.recentShares.set(key, true);
      await this.prisma.post.update({
        where: { id: postId },
        data: { sharesCount: { increment: 1 } },
      });
    }
    return { ok: true };
  }

  /** Vues envoyées par lots par l'app (une requête toutes les ~10 s au lieu d'une par post). */
  async recordViews(userId: string, postIds: string[]) {
    if (!postIds.length) return { ok: true };
    await this.prisma.$executeRaw`
      WITH ins AS (
        INSERT INTO "PostView" ("userId", "postId")
        SELECT ${userId}::uuid, p."id" FROM "Post" p
        WHERE p."id" = ANY(${postIds}::uuid[]) AND p."status" = 'PUBLISHED'
        ON CONFLICT ("userId", "postId") DO UPDATE SET "viewedAt" = now()
        RETURNING "postId", (xmax = 0) AS inserted
      )
      UPDATE "Post" SET "viewsCount" = "viewsCount" + 1
      WHERE "id" IN (SELECT "postId" FROM ins WHERE inserted)`;
    return { ok: true };
  }

  async notInterested(userId: string, postId: string) {
    await this.visiblePost(userId, postId);
    await this.prisma.notInterested.createMany({
      data: [{ userId, postId }],
      skipDuplicates: true,
    });
    return { ok: true };
  }

  async undoNotInterested(userId: string, postId: string) {
    await this.prisma.notInterested.deleteMany({ where: { userId, postId } });
    return { ok: true };
  }

  /* ---------- Commentaires ---------- */

  async listComments(
    viewerId: string,
    postId: string,
    cursorStr?: string,
    limitRaw?: number,
  ) {
    await this.visiblePost(viewerId, postId);
    const limit = clampLimit(limitRaw, 20);
    const cursor = decodeCursor<{ c: string; id: string }>(cursorStr);
    const hidden = await this.social.hiddenUserIds(viewerId);

    const rows = await this.prisma.comment.findMany({
      where: {
        postId,
        ...(hidden.length ? { authorId: { notIn: hidden } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.c) } },
                { createdAt: new Date(cursor.c), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        text: true,
        likesCount: true,
        createdAt: true,
        author: { select: { id: true, username: true, avatarKey: true } },
        post: { select: { authorId: true } },
      },
    });
    const page = rows.slice(0, limit);
    const liked = new Set(
      (
        await this.prisma.commentLike.findMany({
          where: { userId: viewerId, commentId: { in: page.map((c) => c.id) } },
          select: { commentId: true },
        })
      ).map((l) => l.commentId),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((c) => ({
        id: c.id,
        author: toAuthor(c.author),
        text: c.text,
        createdAt: c.createdAt.toISOString(),
        likes: c.likesCount,
        isLiked: liked.has(c.id),
        canDelete: c.author.id === viewerId || c.post.authorId === viewerId,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async addComment(userId: string, postId: string, dto: CommentDto) {
    const post = await this.visiblePost(userId, postId);
    if (post.status !== 'PUBLISHED')
      throw new ForbiddenException('Impossible de commenter ce post');
    await this.assertCleanText(userId, dto.text);

    const [comment] = await this.prisma.$transaction([
      this.prisma.comment.create({
        data: { postId, authorId: userId, text: dto.text },
        select: {
          id: true,
          text: true,
          likesCount: true,
          createdAt: true,
          author: { select: { id: true, username: true, avatarKey: true } },
        },
      }),
      this.prisma.post.update({
        where: { id: postId },
        data: { commentsCount: { increment: 1 } },
      }),
    ]);
    this.background(
      this.notifications.notify({
        userId: post.author.id,
        type: 'COMMENT',
        actorId: userId,
        postId,
        text: dto.text.slice(0, 120),
      }),
    );
    return {
      id: comment.id,
      author: toAuthor(comment.author),
      text: comment.text,
      createdAt: comment.createdAt.toISOString(),
      likes: 0,
      isLiked: false,
      canDelete: true,
    };
  }

  async deleteComment(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        authorId: true,
        postId: true,
        post: { select: { authorId: true } },
      },
    });
    if (
      !comment ||
      (comment.authorId !== userId && comment.post.authorId !== userId)
    ) {
      throw new NotFoundException('Commentaire introuvable');
    }
    await this.prisma.$transaction([
      this.prisma.comment.delete({ where: { id: commentId } }),
      this.prisma.post.updateMany({
        where: { id: comment.postId, commentsCount: { gt: 0 } },
        data: { commentsCount: { decrement: 1 } },
      }),
    ]);
    return { ok: true };
  }

  async setCommentLike(userId: string, commentId: string, on: boolean) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { postId: true },
    });
    if (!comment) throw new NotFoundException('Commentaire introuvable');
    await this.visiblePost(userId, comment.postId);
    if (on) {
      const { count } = await this.prisma.commentLike.createMany({
        data: [{ userId, commentId }],
        skipDuplicates: true,
      });
      if (count)
        await this.prisma.comment.update({
          where: { id: commentId },
          data: { likesCount: { increment: 1 } },
        });
    } else {
      const { count } = await this.prisma.commentLike.deleteMany({
        where: { userId, commentId },
      });
      if (count) {
        await this.prisma.comment.updateMany({
          where: { id: commentId, likesCount: { gt: 0 } },
          data: { likesCount: { decrement: 1 } },
        });
      }
    }
    return { liked: on };
  }

  /* ---------- Signalements ---------- */

  async report(userId: string, dto: ReportDto) {
    const targetType = dto.targetType.toUpperCase() as
      'POST' | 'USER' | 'COMMENT';
    const exists =
      targetType === 'POST'
        ? await this.prisma.post.count({ where: { id: dto.targetId } })
        : targetType === 'USER'
          ? await this.prisma.user.count({ where: { id: dto.targetId } })
          : await this.prisma.comment.count({ where: { id: dto.targetId } });
    if (!exists) throw new NotFoundException('Introuvable');
    if (targetType === 'USER' && dto.targetId === userId)
      throw new BadRequestException('Action impossible');

    try {
      await this.prisma.report.create({
        data: {
          reporterId: userId,
          targetType,
          targetId: dto.targetId,
          reason: dto.reason,
          details: dto.details,
        },
      });
    } catch (e) {
      // Déjà signalé : on répond OK sans créer de doublon.
      if (!(
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
      ))
        throw e;
    }
    return { ok: true };
  }
}
