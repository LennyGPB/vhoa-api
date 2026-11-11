import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

import { OpenAiService } from '../ai/openai.service';
import { RESERVED_USERNAMES } from '../auth/auth.dto';
import { CoachService } from '../coach/coach.service';
import { AuthUser } from '../common/auth.decorators';
import { clampLimit, decodeCursor, encodeCursor } from '../common/cursor';
import { JwtAuthGuard } from '../common/guards';
import {
  POST_CARD_SELECT,
  PostRow,
  publicUrl,
  toAuthor,
  toPost,
} from '../common/mappers';
import { Prisma } from '../generated/prisma/client';
import { JobsService } from '../jobs/jobs.service';
import { StorageService } from '../media/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SocialService } from '../posts/social.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';
import {
  AppealDto,
  AvatarConfirmDto,
  AvatarUploadDto,
  PushTokenDto,
  SettingsDto,
  UpdateMeDto,
} from './users.dto';

const AVATAR_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
/** Un appareil ne garde qu'une poignée de jetons push par compte. */
const MAX_PUSH_TOKENS = 5;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly social: SocialService,
    private readonly progress: ProgressService,
    private readonly notifications: NotificationsService,
    private readonly openai: OpenAiService,
    private readonly coach: CoachService,
    private readonly jobs: JobsService,
  ) {}

  /** Le compte connecté, avec tout ce dont l'app a besoin au démarrage. */
  async me(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('Compte introuvable');
    const isPremium = !!u.premiumUntil && u.premiumUntil > new Date();
    const [quota, unreadNotifications] = await Promise.all([
      this.coach.quota({ id: u.id, role: u.role, isPremium }),
      this.notifications.unreadCount(u.id),
    ]);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      avatarUrl: publicUrl(u.avatarKey),
      email: u.email ?? u.socialEmail ?? null,
      providers: [
        u.passwordHash && 'password',
        u.appleSub && 'apple',
        u.googleSub && 'google',
      ].filter(Boolean),
      role: u.role.toLowerCase(),
      isPremium,
      premiumUntil: u.premiumUntil?.toISOString() ?? null,
      followers: u.followersCount,
      following: u.followingCount,
      postsCount: u.postsCount,
      notifications: {
        interactions: u.notifyInteractions,
        themes: u.notifyThemes,
        progress: u.notifyProgress,
      },
      aiQuota: {
        used: quota.used,
        total: quota.total,
        isPremium: quota.isPremium,
      },
      unreadNotifications,
      createdAt: u.createdAt.toISOString(),
    };
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    if (dto.username && RESERVED_USERNAMES.has(dto.username)) {
      throw new ConflictException({
        code: 'USERNAME_TAKEN',
        message: 'Ce pseudo est déjà pris',
      });
    }
    const text = [dto.username, dto.displayName, dto.bio]
      .filter(Boolean)
      .join('\n');
    if (text) {
      const verdict = await this.openai.moderate({ text });
      if (verdict.flagged) {
        throw new UnprocessableEntityException({
          code: 'CONTENT_REJECTED',
          message: 'Ce texte ne respecte pas les règles de la communauté',
        });
      }
    }
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          username: dto.username,
          displayName: dto.displayName,
          bio: dto.bio,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          message: 'Ce pseudo est déjà pris',
        });
      }
      throw e;
    }
    return this.me(userId);
  }

  async updateSettings(userId: string, dto: SettingsDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        notifyInteractions: dto.interactions,
        notifyThemes: dto.themes,
        notifyProgress: dto.progress,
      },
    });
    return this.me(userId);
  }

  /* ---------- Avatar ---------- */

  async avatarUploadUrl(userId: string, dto: AvatarUploadDto) {
    const key = `a/${userId}/${randomBytes(16).toString('hex')}.${AVATAR_EXT[dto.mimeType]}`;
    return {
      key,
      uploadUrl: await this.storage.presignUpload(
        key,
        dto.mimeType,
        dto.sizeBytes,
      ),
      method: 'PUT',
      headers: { 'Content-Type': dto.mimeType },
    };
  }

  async confirmAvatar(userId: string, dto: AvatarConfirmDto) {
    if (!dto.key.startsWith(`a/${userId}/`))
      throw new ForbiddenException('Action impossible');
    const head = await this.storage.head(dto.key);
    if (
      !head ||
      head.size > 2 * 1024 * 1024 ||
      !head.contentType.startsWith('image/')
    ) {
      throw new BadRequestException({
        code: 'UPLOAD_MISSING',
        message: 'Image non reçue ou invalide',
      });
    }
    const verdict = await this.openai.moderate({
      images: [publicUrl(dto.key)],
    });
    if (verdict.flagged) {
      await this.storage.deleteKeys([dto.key]);
      throw new UnprocessableEntityException({
        code: 'CONTENT_REJECTED',
        message: 'Cette image ne respecte pas les règles de la communauté',
      });
    }
    const previous = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarKey: dto.key },
    });
    if (previous?.avatarKey)
      await this.storage
        .deleteKeys([previous.avatarKey])
        .catch(() => undefined);
    return this.me(userId);
  }

  /* ---------- Profils ---------- */

  async profile(viewerId: string, userId: string) {
    if (userId !== viewerId) {
      // Quelqu'un qui m'a bloqué n'apparaît plus ; quelqu'un que j'ai bloqué reste visible pour pouvoir le débloquer.
      const blockedMe = await this.prisma.block.count({
        where: { blockerId: userId, blockedId: viewerId },
      });
      if (blockedMe) throw new NotFoundException('Profil introuvable');
    }
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        avatarKey: true,
        status: true,
        followersCount: true,
        followingCount: true,
        postsCount: true,
        premiumUntil: true,
        streakCurrent: true,
        streakBest: true,
        streakFreezes: true,
        streakLastWeek: true,
      },
    });
    if (!u || u.status === 'BANNED')
      throw new NotFoundException('Profil introuvable');

    const [streak, badges, isFollowing, isBlocked] = await Promise.all([
      this.progress.streakOf(u.id, u),
      this.progress.badgesOf(u.id),
      viewerId === userId
        ? false
        : this.prisma.follow
            .count({ where: { followerId: viewerId, followingId: userId } })
            .then(Boolean),
      viewerId === userId
        ? false
        : this.prisma.block
            .count({ where: { blockerId: viewerId, blockedId: userId } })
            .then(Boolean),
    ]);
    return {
      ...toAuthor(u),
      displayName: u.displayName,
      bio: u.bio,
      followers: u.followersCount,
      following: u.followingCount,
      postsCount: u.postsCount,
      streak: viewerId === userId ? streak : { ...streak, freezes: 0 },
      badges,
      isPremium: !!u.premiumUntil && u.premiumUntil > new Date(),
      isFollowing,
      isBlocked,
      isMe: viewerId === userId,
    };
  }

  private async postPage(
    where: Prisma.PostWhereInput,
    cursorStr?: string,
    limitRaw?: number,
  ) {
    const limit = clampLimit(limitRaw, 18, 48);
    const cursor = decodeCursor<{ id: string }>(cursorStr);
    const rows = (await this.prisma.post.findMany({
      where: { ...where, ...(cursor ? { id: { lt: cursor.id } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: POST_CARD_SELECT,
    })) as PostRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((p) => ({
        ...toPost(p),
        status: p.status.toLowerCase(),
      })),
      nextCursor:
        rows.length > limit
          ? encodeCursor({ id: page[page.length - 1].id })
          : null,
    };
  }

  async userPosts(
    viewerId: string,
    userId: string,
    cursor?: string,
    limit?: number,
  ) {
    if (viewerId !== userId && (await this.social.isHidden(viewerId, userId))) {
      return { items: [], nextCursor: null };
    }
    return this.postPage(
      { authorId: userId, status: 'PUBLISHED' },
      cursor,
      limit,
    );
  }

  /** Brouillons + prises privées pour le coach + posts en cours de traitement. */
  drafts(userId: string, cursor?: string, limit?: number) {
    return this.postPage(
      {
        authorId: userId,
        status: {
          in: ['DRAFT', 'PRIVATE', 'PROCESSING', 'FAILED', 'REJECTED'],
        },
      },
      cursor,
      limit,
    );
  }

  async saved(userId: string, cursorStr?: string, limitRaw?: number) {
    const limit = clampLimit(limitRaw, 18, 48);
    const cursor = decodeCursor<{ c: string; p: string }>(cursorStr);
    const hidden = await this.social.hiddenUserIds(userId);
    const rows = await this.prisma.save.findMany({
      where: {
        userId,
        post: {
          status: 'PUBLISHED',
          ...(hidden.length ? { authorId: { notIn: hidden } } : {}),
        },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.c) } },
                { createdAt: new Date(cursor.c), postId: { lt: cursor.p } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
      take: limit + 1,
      select: {
        createdAt: true,
        postId: true,
        post: { select: POST_CARD_SELECT },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((s) => toPost(s.post as PostRow)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ c: last.createdAt.toISOString(), p: last.postId })
          : null,
    };
  }

  /* ---------- Abonnements & blocages ---------- */

  async follow(viewerId: string, userId: string, on: boolean) {
    if (viewerId === userId)
      throw new BadRequestException('Tu ne peux pas te suivre toi-même');
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!target || target.status === 'BANNED')
      throw new NotFoundException('Profil introuvable');
    if (on && (await this.social.isHidden(viewerId, userId)))
      throw new ForbiddenException('Action impossible');

    if (on) {
      const { count } = await this.prisma.follow.createMany({
        data: [{ followerId: viewerId, followingId: userId }],
        skipDuplicates: true,
      });
      if (count) {
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: viewerId },
            data: { followingCount: { increment: 1 } },
          }),
          this.prisma.user.update({
            where: { id: userId },
            data: { followersCount: { increment: 1 } },
          }),
        ]);
        this.notifications
          .notify({ userId, type: 'FOLLOW', actorId: viewerId })
          .catch(() => undefined);
      }
    } else {
      await this.unfollow(viewerId, userId);
    }
    return { following: on };
  }

  private async unfollow(followerId: string, followingId: string) {
    const { count } = await this.prisma.follow.deleteMany({
      where: { followerId, followingId },
    });
    if (count) {
      await this.prisma.$transaction([
        this.prisma.user.updateMany({
          where: { id: followerId, followingCount: { gt: 0 } },
          data: { followingCount: { decrement: 1 } },
        }),
        this.prisma.user.updateMany({
          where: { id: followingId, followersCount: { gt: 0 } },
          data: { followersCount: { decrement: 1 } },
        }),
      ]);
    }
  }

  async block(viewerId: string, userId: string, on: boolean) {
    if (viewerId === userId) throw new BadRequestException('Action impossible');
    if (!(await this.prisma.user.count({ where: { id: userId } })))
      throw new NotFoundException('Profil introuvable');
    if (on) {
      await this.prisma.block.createMany({
        data: [{ blockerId: viewerId, blockedId: userId }],
        skipDuplicates: true,
      });
      // Bloquer, c'est aussi ne plus se suivre dans les deux sens.
      await this.unfollow(viewerId, userId);
      await this.unfollow(userId, viewerId);
    } else {
      await this.prisma.block.deleteMany({
        where: { blockerId: viewerId, blockedId: userId },
      });
    }
    this.social.invalidateBlocks(viewerId, userId);
    return { blocked: on };
  }

  async blockedList(userId: string) {
    const rows = await this.prisma.block.findMany({
      where: { blockerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        blocked: { select: { id: true, username: true, avatarKey: true } },
      },
    });
    return rows.map((r) => toAuthor(r.blocked));
  }

  /* ---------- Push ---------- */

  async addPushToken(userId: string, dto: PushTokenDto) {
    await this.prisma.pushToken.upsert({
      where: { token: dto.token },
      create: { token: dto.token, platform: dto.platform, userId },
      update: { userId, platform: dto.platform },
    });
    const extra = await this.prisma.pushToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: MAX_PUSH_TOKENS,
      select: { id: true },
    });
    if (extra.length)
      await this.prisma.pushToken.deleteMany({
        where: { id: { in: extra.map((t) => t.id) } },
      });
    return { ok: true };
  }

  /* ---------- Modération ---------- */

  async appeal(userId: string, dto: AppealDto) {
    if (dto.postId) {
      const post = await this.prisma.post.findUnique({
        where: { id: dto.postId },
        select: { authorId: true },
      });
      if (!post || post.authorId !== userId)
        throw new NotFoundException('Post introuvable');
    }
    const open = await this.prisma.appeal.count({
      where: { userId, status: 'OPEN' },
    });
    if (open >= 5)
      throw new ConflictException(
        'Tu as déjà des contestations en cours de traitement',
      );
    await this.prisma.appeal.create({
      data: { userId, postId: dto.postId, message: dto.message },
    });
    return { ok: true };
  }

  /* ---------- Suppression du compte ---------- */

  async deleteAccount(user: AuthUser, password?: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true, avatarKey: true },
    });
    if (!u) return { ok: true };
    if (u.passwordHash) {
      if (
        !password ||
        !(await argon2.verify(u.passwordHash, password).catch(() => false))
      ) {
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Mot de passe incorrect',
        });
      }
    }
    const prefixes = await this.prisma.post.findMany({
      where: { authorId: user.id },
      select: { mediaPrefix: true },
    });

    await this.prisma.$transaction(async (tx) => {
      const id = user.id;
      // Les compteurs des autres comptes restent justes après la suppression.
      await tx.$executeRaw`UPDATE "User" SET "followersCount" = GREATEST(0, "followersCount" - 1) WHERE "id" IN (SELECT "followingId" FROM "Follow" WHERE "followerId" = ${id}::uuid)`;
      await tx.$executeRaw`UPDATE "User" SET "followingCount" = GREATEST(0, "followingCount" - 1) WHERE "id" IN (SELECT "followerId" FROM "Follow" WHERE "followingId" = ${id}::uuid)`;
      await tx.$executeRaw`UPDATE "Post" SET "likesCount" = GREATEST(0, "likesCount" - 1) WHERE "id" IN (SELECT "postId" FROM "Like" WHERE "userId" = ${id}::uuid)`;
      await tx.$executeRaw`UPDATE "Post" SET "savesCount" = GREATEST(0, "savesCount" - 1) WHERE "id" IN (SELECT "postId" FROM "Save" WHERE "userId" = ${id}::uuid)`;
      await tx.$executeRaw`UPDATE "Post" p SET "convincedCount" = GREATEST(0, p."convincedCount" - 1) FROM "Convinced" c WHERE c."postId" = p."id" AND c."userId" = ${id}::uuid`;
      await tx.$executeRaw`UPDATE "User" u SET "convincedTotal" = GREATEST(0, u."convincedTotal" - x.n) FROM (SELECT p."authorId", count(*)::int AS n FROM "Convinced" c JOIN "Post" p ON p."id" = c."postId" WHERE c."userId" = ${id}::uuid GROUP BY p."authorId") x WHERE u."id" = x."authorId"`;
      await tx.$executeRaw`UPDATE "Post" p SET "commentsCount" = GREATEST(0, p."commentsCount" - x.n) FROM (SELECT "postId", count(*)::int AS n FROM "Comment" WHERE "authorId" = ${id}::uuid GROUP BY "postId") x WHERE p."id" = x."postId"`;
      await tx.user.delete({ where: { id } });
    });

    JwtAuthGuard.invalidate(user.id);
    for (const p of prefixes)
      await this.jobs.enqueue('media.delete', { prefix: p.mediaPrefix });
    if (u.avatarKey)
      await this.jobs.enqueue('media.delete', { prefix: `a/${user.id}/` });
    return { ok: true };
  }
}
