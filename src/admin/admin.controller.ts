import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { type AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import {
  AUTHOR_SELECT,
  POST_CARD_SELECT,
  type PostRow,
  publicUrl,
  toAuthor,
  toPost,
} from '../common/mappers';
import { Prisma } from '../generated/prisma/client';
import { JwtAuthGuard } from '../common/guards';
import { NotificationsService } from '../notifications/notifications.service';
import { PostLifecycleService } from '../posts/post-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThemesService } from '../themes/themes.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const uuid = new ParseUUIDPipe();

class ThemeDto {
  @IsIn(['weekly', 'monthly'])
  period!: 'weekly' | 'monthly';

  /** N'importe quelle date de la semaine / du mois visé. */
  @IsDateString()
  date!: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(140)
  subject!: string;
}

class SubjectDto {
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(140)
  subject!: string;
}

class ResolveDto {
  @IsIn(['RESOLVED', 'DISMISSED'])
  status!: 'RESOLVED' | 'DISMISSED';
}

class RoleDto {
  @IsIn(['ADMIN', 'USER'])
  role!: 'ADMIN' | 'USER';
}

const POST_STATUSES = [
  'PUBLISHED',
  'PROCESSING',
  'DRAFT',
  'PRIVATE',
  'REJECTED',
  'REMOVED',
  'FAILED',
] as const;
type AdminPostStatus = (typeof POST_STATUSES)[number];

const DAY = 24 * 3600_000;

class ReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: PostLifecycleService,
    private readonly notifications: NotificationsService,
  ) {}

  async removePost(postId: string, reason?: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { status: true, authorId: true },
    });
    if (!post) throw new NotFoundException('Post introuvable');
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'REMOVED',
        moderationReason:
          reason ?? 'Contenu contraire aux règles de la communauté',
      },
    });
    if (post.status === 'PUBLISHED')
      await this.lifecycle.onUnpublished(postId, post.authorId);
    await this.prisma.report.updateMany({
      where: { targetType: 'POST', targetId: postId, status: 'OPEN' },
      data: { status: 'RESOLVED' },
    });
    await this.notifications.notify({
      userId: post.authorId,
      type: 'MODERATION',
      postId,
      text: 'Une de tes publications a été retirée par la modération. Tu peux contester depuis les paramètres.',
    });
    return { ok: true };
  }

  /** Accepter une contestation : le post refusé ou retiré est republié. */
  async restorePost(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { status: true, mode: true },
    });
    if (!post || !['REMOVED', 'REJECTED'].includes(post.status))
      throw new NotFoundException('Post introuvable');
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'PUBLISHED',
        moderationReason: null,
        publishedAt: new Date(),
      },
    });
    await this.lifecycle.onPublished(postId);
    return { ok: true };
  }

  async ban(userId: string, on: boolean) {
    await this.prisma.user.update({
      where: { id: userId },
      data: on
        ? { status: 'BANNED', tokenVersion: { increment: 1 } }
        : { status: 'ACTIVE' },
    });
    if (on)
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    JwtAuthGuard.invalidate(userId);
    return { ok: true };
  }

  /** Chiffres clés du tableau de bord + courbes des 14 derniers jours (fuseau Europe/Paris). */
  async stats() {
    const now = Date.now();
    const since1 = new Date(now - DAY);
    const since7 = new Date(now - 7 * DAY);
    const since14 = new Date(now - 14 * DAY);
    const month = new Date().toISOString().slice(0, 7);
    const p = this.prisma;
    const [
      users,
      users7,
      users1,
      banned,
      premium,
      posts,
      posts7,
      posts1,
      processing,
      reportsOpen,
      appealsOpen,
      analysesMonth,
      comments7,
      waitlist,
      theme,
      active,
      signupSeries,
      postSeries,
    ] = await Promise.all([
      p.user.count(),
      p.user.count({ where: { createdAt: { gte: since7 } } }),
      p.user.count({ where: { createdAt: { gte: since1 } } }),
      p.user.count({ where: { status: 'BANNED' } }),
      p.user.count({ where: { premiumUntil: { gt: new Date() } } }),
      p.post.count({ where: { status: 'PUBLISHED' } }),
      p.post.count({
        where: { status: 'PUBLISHED', publishedAt: { gte: since7 } },
      }),
      p.post.count({
        where: { status: 'PUBLISHED', publishedAt: { gte: since1 } },
      }),
      p.post.count({ where: { status: 'PROCESSING' } }),
      p.report.count({ where: { status: 'OPEN' } }),
      p.appeal.count({ where: { status: 'OPEN' } }),
      p.analysis.count({ where: { month } }),
      p.comment.count({ where: { createdAt: { gte: since7 } } }),
      p.waitlistEntry.count(),
      p.theme.findFirst({
        where: { status: 'ACTIVE', period: 'WEEKLY' },
        select: { subject: true, participantsCount: true, endsAt: true },
      }),
      // Membres actifs sur 7 jours : ont regardé, aimé, commenté ou publié.
      p.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT u)::int AS n FROM (
          SELECT "userId" AS u FROM "PostView" WHERE "viewedAt" >= ${since7}
          UNION SELECT "userId" FROM "Like" WHERE "createdAt" >= ${since7}
          UNION SELECT "authorId" FROM "Comment" WHERE "createdAt" >= ${since7}
          UNION SELECT "authorId" FROM "Post" WHERE "createdAt" >= ${since7}
        ) t`,
      p.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS d, count(*)::int AS n
        FROM "User" WHERE "createdAt" >= ${since14} GROUP BY 1 ORDER BY 1`,
      p.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char(("publishedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS d, count(*)::int AS n
        FROM "Post" WHERE "status" = 'PUBLISHED' AND "publishedAt" >= ${since14} GROUP BY 1 ORDER BY 1`,
    ]);
    return {
      users: {
        total: users,
        last7: users7,
        last24h: users1,
        banned,
        premium,
        active7: active[0]?.n ?? 0,
      },
      posts: { published: posts, last7: posts7, last24h: posts1, processing },
      moderation: { reportsOpen, appealsOpen },
      engagement: { comments7, analysesMonth },
      waitlist,
      theme: theme
        ? {
            subject: theme.subject,
            participants: theme.participantsCount,
            endsAt: theme.endsAt.toISOString(),
          }
        : null,
      series: { signups: signupSeries, posts: postSeries },
    };
  }

  /** Membres, du plus récent au plus ancien, avec recherche (pseudo, nom, email). */
  async users(q?: string) {
    const term = q?.trim().slice(0, 60);
    const rows = await this.prisma.user.findMany({
      where: term
        ? {
            OR: [
              { username: { contains: term, mode: 'insensitive' } },
              { displayName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
              { socialEmail: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarKey: true,
        email: true,
        socialEmail: true,
        role: true,
        status: true,
        postsCount: true,
        followersCount: true,
        premiumUntil: true,
        passwordHash: true,
        googleSub: true,
        appleSub: true,
        createdAt: true,
      },
    });
    return rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      avatarUrl: publicUrl(u.avatarKey),
      email: u.email ?? u.socialEmail ?? null,
      providers: [
        u.passwordHash && 'password',
        u.googleSub && 'google',
        u.appleSub && 'apple',
      ].filter(Boolean),
      role: u.role,
      status: u.status,
      isPremium: !!u.premiumUntil && u.premiumUntil > new Date(),
      postsCount: u.postsCount,
      followers: u.followersCount,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /** Change le rôle d'un compte. On ne peut pas se retirer soi-même le rôle admin (pas de verrouillage). */
  async setRole(actorId: string, userId: string, role: 'ADMIN' | 'USER') {
    if (actorId === userId && role !== 'ADMIN')
      throw new BadRequestException({
        code: 'SELF_DEMOTE',
        message: 'Tu ne peux pas te retirer le rôle admin toi-même',
      });
    await this.prisma.user.update({ where: { id: userId }, data: { role } });
    JwtAuthGuard.invalidate(userId);
    return { ok: true };
  }

  /** Prises (tous statuts sauf envoi en cours), filtrables et cherchables (titre, pseudo). */
  async posts(status?: string, q?: string) {
    const wanted = POST_STATUSES.includes(status as AdminPostStatus)
      ? (status as AdminPostStatus)
      : undefined;
    const term = q?.trim().slice(0, 60);
    const where: Prisma.PostWhereInput = {
      status: wanted ?? { not: 'UPLOADING' },
      ...(term
        ? {
            OR: [
              { title: { contains: term, mode: 'insensitive' } },
              { author: { username: { contains: term, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.post.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        ...POST_CARD_SELECT,
        mediaKey: true,
        mode: true,
        moderationReason: true,
        processingError: true,
      },
    });
    return rows.map((p) => ({
      ...toPost(p as unknown as PostRow),
      status: p.status.toLowerCase(),
      mode: p.mode.toLowerCase(),
      mediaUrl: publicUrl(p.mediaKey),
      convinced: p.convincedCount,
      theme: p.theme ? p.theme.subject : null,
      reason: p.moderationReason ?? p.processingError ?? null,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  /** Signalements avec un aperçu de ce qui est visé (prise, commentaire ou profil). */
  async reports(status: string) {
    const rows = await this.prisma.report.findMany({
      where: {
        status: ['OPEN', 'RESOLVED', 'DISMISSED'].includes(status)
          ? (status as 'OPEN')
          : 'OPEN',
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { reporter: { select: { id: true, username: true } } },
    });
    const ids = (t: string) =>
      rows.filter((r) => r.targetType === t).map((r) => r.targetId);
    const [posts, comments, users] = await Promise.all([
      this.prisma.post.findMany({
        where: { id: { in: ids('POST') } },
        select: { ...POST_CARD_SELECT, mediaKey: true },
      }),
      this.prisma.comment.findMany({
        where: { id: { in: ids('COMMENT') } },
        select: {
          id: true,
          text: true,
          postId: true,
          author: { select: AUTHOR_SELECT },
        },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ids('USER') } },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarKey: true,
          status: true,
          bio: true,
        },
      }),
    ]);
    const postById = new Map(posts.map((p) => [p.id, p]));
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u]));
    // Nombre de signalements ouverts par cible : les plus signalées ressortent.
    const counts = await this.prisma.report.groupBy({
      by: ['targetType', 'targetId'],
      where: { status: 'OPEN', targetId: { in: rows.map((r) => r.targetId) } },
      _count: { _all: true },
    });
    const countOf = (type: string, id: string) =>
      counts.find((c) => c.targetType === type && c.targetId === id)?._count
        ._all ?? 1;

    return rows.map((r) => {
      let target: Record<string, unknown> | null = null;
      if (r.targetType === 'POST') {
        const p = postById.get(r.targetId);
        if (p)
          target = {
            ...toPost(p as unknown as PostRow),
            status: p.status.toLowerCase(),
            mediaUrl: publicUrl(p.mediaKey),
          };
      } else if (r.targetType === 'COMMENT') {
        const c = commentById.get(r.targetId);
        if (c)
          target = {
            id: c.id,
            text: c.text,
            postId: c.postId,
            author: toAuthor(c.author),
          };
      } else {
        const u = userById.get(r.targetId);
        if (u)
          target = {
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            avatarUrl: publicUrl(u.avatarKey),
            status: u.status,
            bio: u.bio,
          };
      }
      return {
        id: r.id,
        targetType: r.targetType.toLowerCase(),
        targetId: r.targetId,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        reporter: r.reporter,
        openCount: countOf(r.targetType, r.targetId),
        target,
      };
    });
  }

  /** Supprime un commentaire (modération) et clôt ses signalements. */
  async removeComment(commentId: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { postId: true },
    });
    if (!comment) throw new NotFoundException('Commentaire introuvable');
    await this.prisma.$transaction([
      this.prisma.comment.delete({ where: { id: commentId } }),
      this.prisma.post.updateMany({
        where: { id: comment.postId, commentsCount: { gt: 0 } },
        data: { commentsCount: { decrement: 1 } },
      }),
      this.prisma.report.updateMany({
        where: { targetType: 'COMMENT', targetId: commentId, status: 'OPEN' },
        data: { status: 'RESOLVED' },
      }),
    ]);
    return { ok: true };
  }
}

/** Back-office : réservé aux comptes `ADMIN` (à attribuer en base, voir README). */
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly themes: ThemesService,
    private readonly admin: AdminService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('themes')
  listThemes(@Query('status') status?: string) {
    return this.themes.list(status);
  }

  @Post('themes')
  upsertTheme(@Body() dto: ThemeDto) {
    return this.themes.upsertForPeriod(
      dto.period === 'weekly' ? 'WEEKLY' : 'MONTHLY',
      new Date(dto.date),
      dto.subject,
    );
  }

  @Patch('themes/:id')
  updateTheme(@Param('id', uuid) id: string, @Body() dto: SubjectDto) {
    return this.themes.updateSubject(id, dto.subject);
  }

  @Post('themes/:id/regenerate')
  @HttpCode(200)
  regenerate(@Param('id', uuid) id: string) {
    return this.themes.regenerate(id);
  }

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('users')
  users(@Query('q') q?: string) {
    return this.admin.users(q);
  }

  @Patch('users/:id/role')
  setRole(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: RoleDto,
  ) {
    return this.admin.setRole(user.id, id, dto.role);
  }

  @Get('posts')
  posts(@Query('status') status?: string, @Query('q') q?: string) {
    return this.admin.posts(status?.toUpperCase(), q);
  }

  @Delete('comments/:id')
  removeComment(@Param('id', uuid) id: string) {
    return this.admin.removeComment(id);
  }

  @Get('reports')
  reports(@Query('status') status = 'OPEN') {
    return this.admin.reports(status);
  }

  @Patch('reports/:id')
  resolveReport(@Param('id', uuid) id: string, @Body() dto: ResolveDto) {
    return this.prisma.report.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  @Get('appeals')
  appeals() {
    return this.prisma.appeal.findMany({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: { select: { id: true, username: true } } },
    });
  }

  @Get('appeals/full')
  async appealsFull() {
    const rows = await this.prisma.appeal.findMany({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        user: { select: AUTHOR_SELECT },
      },
    });
    const posts = await this.prisma.post.findMany({
      where: {
        id: {
          in: rows.map((a) => a.postId).filter((id): id is string => !!id),
        },
      },
      select: { ...POST_CARD_SELECT, mediaKey: true, moderationReason: true },
    });
    const byId = new Map(posts.map((p) => [p.id, p]));
    return rows.map((a) => {
      const p = a.postId ? byId.get(a.postId) : undefined;
      return {
        id: a.id,
        message: a.message,
        createdAt: a.createdAt.toISOString(),
        user: toAuthor(a.user),
        post: p
          ? {
              ...toPost(p as unknown as PostRow),
              status: p.status.toLowerCase(),
              mediaUrl: publicUrl(p.mediaKey),
              reason: p.moderationReason,
            }
          : null,
      };
    });
  }

  @Patch('appeals/:id')
  resolveAppeal(@Param('id', uuid) id: string, @Body() dto: ResolveDto) {
    return this.prisma.appeal.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  @Post('posts/:id/remove')
  @HttpCode(200)
  removePost(@Param('id', uuid) id: string, @Body() dto: ReasonDto) {
    return this.admin.removePost(id, dto.reason);
  }

  @Post('posts/:id/restore')
  @HttpCode(200)
  restorePost(@Param('id', uuid) id: string) {
    return this.admin.restorePost(id);
  }

  @Post('users/:id/ban')
  @HttpCode(200)
  ban(@Param('id', uuid) id: string) {
    return this.admin.ban(id, true);
  }

  @Post('users/:id/unban')
  @HttpCode(200)
  unban(@Param('id', uuid) id: string) {
    return this.admin.ban(id, false);
  }
}
