import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { clampLimit, decodeCursor, encodeCursor, Page } from '../common/cursor';
import { publicUrl, toAuthor } from '../common/mappers';
import { env } from '../config/env';
import { NotificationType } from '../generated/prisma/enums';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';

type Group = 'interactions' | 'themes' | 'progress' | 'system';

const GROUP: Record<NotificationType, Group> = {
  LIKE: 'interactions',
  COMMENT: 'interactions',
  FOLLOW: 'interactions',
  CONVINCED: 'interactions',
  THEME_NEW: 'themes',
  THEME_RESULT: 'themes',
  BADGE: 'progress',
  STREAK_RISK: 'progress',
  ANALYSIS_READY: 'progress',
  MODERATION: 'system',
};

/** Types regroupés tant qu'ils ne sont pas lus (« Lina et 12 autres ont aimé… »). */
const GROUPABLE = new Set<NotificationType>([
  'LIKE',
  'COMMENT',
  'FOLLOW',
  'CONVINCED',
]);

const APP_TYPE: Record<NotificationType, string> = {
  LIKE: 'like',
  COMMENT: 'comment',
  FOLLOW: 'follow',
  CONVINCED: 'convinced',
  THEME_NEW: 'themeNew',
  THEME_RESULT: 'themeResult',
  BADGE: 'badge',
  STREAK_RISK: 'streakRisk',
  MODERATION: 'moderation',
  ANALYSIS_READY: 'analysisReady',
};

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  actorId?: string;
  postId?: string;
  text?: string;
  rank?: number;
}

interface PushMessage {
  to: string;
  title?: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default';
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register(
      'push.send',
      (p: {
        userIds: string[];
        type: NotificationType;
        body: string;
        data?: Record<string, string>;
      }) => this.sendPush(p.userIds, p.type, p.body, p.data),
    );
    this.jobs.register(
      'notify.broadcast',
      (p: { type: NotificationType; text: string; afterId?: string }) =>
        this.broadcastBatch(p.type, p.text, p.afterId),
    );
  }

  /** Crée (ou regroupe) une alerte et déclenche le push si c'est une nouvelle alerte. */
  async notify(input: NotifyInput) {
    if (input.actorId && input.actorId === input.userId) return;
    if (
      input.actorId &&
      (await this.isBlockedEitherWay(input.userId, input.actorId))
    )
      return;

    const groupKey = GROUPABLE.has(input.type)
      ? `${input.type}:${input.postId ?? ''}`
      : null;

    if (groupKey && input.actorId) {
      const existing = await this.prisma.notification.findFirst({
        where: { userId: input.userId, groupKey, read: false },
        select: { id: true, actorIds: true },
      });
      if (existing) {
        if (existing.actorIds[0] === input.actorId) return;
        const isNew = !existing.actorIds.includes(input.actorId);
        await this.prisma.notification.update({
          where: { id: existing.id },
          data: {
            actorIds: [
              input.actorId,
              ...existing.actorIds.filter((id) => id !== input.actorId),
            ].slice(0, 3),
            actorCount: isNew ? { increment: 1 } : undefined,
            text: input.text,
          },
        });
        // Pas de nouveau push : on évite de spammer pour chaque like.
        return;
      }
    }

    await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        actorIds: input.actorId ? [input.actorId] : [],
        actorCount: input.actorId ? 1 : 0,
        postId: input.postId,
        text: input.text?.slice(0, 200),
        rank: input.rank,
        groupKey,
      },
    });

    const body = await this.pushBody(input);
    if (body) {
      await this.jobs.enqueue('push.send', {
        userIds: [input.userId],
        type: input.type,
        body,
        data: {
          type: APP_TYPE[input.type],
          ...(input.postId ? { postId: input.postId } : {}),
        },
      });
    }
  }

  /** Alerte envoyée à tous les comptes (nouveau thème), traitée par lots en arrière-plan. */
  async broadcast(type: NotificationType, text: string) {
    await this.jobs.enqueue('notify.broadcast', { type, text });
  }

  private async broadcastBatch(
    type: NotificationType,
    text: string,
    afterId?: string,
  ) {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 1000,
    });
    if (!users.length) return;
    await this.prisma.notification.createMany({
      data: users.map((u) => ({ userId: u.id, type, text })),
    });
    const body = await this.pushBody({ userId: '', type, text });
    if (body) {
      await this.jobs.enqueue('push.send', {
        userIds: users.map((u) => u.id),
        type,
        body,
        data: { type: APP_TYPE[type] },
      });
    }
    if (users.length === 1000) {
      await this.jobs.enqueue('notify.broadcast', {
        type,
        text,
        afterId: users[users.length - 1].id,
      });
    }
  }

  private async isBlockedEitherWay(a: string, b: string) {
    const count = await this.prisma.block.count({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return count > 0;
  }

  private async pushBody(input: NotifyInput): Promise<string | null> {
    const actor = input.actorId
      ? await this.prisma.user.findUnique({
          where: { id: input.actorId },
          select: { username: true },
        })
      : null;
    const post = input.postId
      ? await this.prisma.post.findUnique({
          where: { id: input.postId },
          select: { title: true },
        })
      : null;
    const who = actor?.username ?? 'Quelqu’un';
    const title = post?.title
      ? `« ${clip(post.title, 40)} »`
      : 'ta prise de parole';
    switch (input.type) {
      case 'LIKE':
        return `${who} a aimé ${title}`;
      case 'COMMENT':
        return `${who} a commenté : ${clip(input.text ?? '', 80)}`;
      case 'FOLLOW':
        return `${who} s’est abonné à toi`;
      case 'CONVINCED':
        return `${who} a voté Convaincu pour ${title}`;
      case 'THEME_NEW':
        return `Nouveau thème : ${clip(input.text ?? '', 90)}`;
      case 'THEME_RESULT':
        return input.rank
          ? `Bravo ! Tu termines n°${input.rank} du thème « ${clip(input.text ?? '', 50)} »`
          : `Les résultats du thème « ${clip(input.text ?? '', 50)} » sont tombés`;
      case 'BADGE':
        return `Nouveau badge débloqué : ${input.text}`;
      case 'STREAK_RISK':
        return (
          input.text ?? 'Ta série est en danger : poste avant dimanche soir !'
        );
      case 'ANALYSIS_READY':
        return 'Ton analyse du coach IA est prête';
      case 'MODERATION':
        return input.text ?? 'Une de tes publications a été modérée';
      default:
        return null;
    }
  }

  /** Envoi via l'API Expo Push, en respectant les préférences de chaque utilisateur. */
  private async sendPush(
    userIds: string[],
    type: NotificationType,
    body: string,
    data?: Record<string, string>,
  ) {
    const group = GROUP[type];
    const prefFilter =
      group === 'interactions'
        ? { notifyInteractions: true }
        : group === 'themes'
          ? { notifyThemes: true }
          : group === 'progress'
            ? { notifyProgress: true }
            : {};
    const tokens = await this.prisma.pushToken.findMany({
      where: {
        userId: { in: userIds },
        user: { status: 'ACTIVE', ...prefFilter },
      },
      select: { token: true },
    });
    if (!tokens.length) return;

    const messages: PushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: 'VHOA',
      body,
      data,
      sound: 'default',
    }));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (env().EXPO_ACCESS_TOKEN)
      headers.Authorization = `Bearer ${env().EXPO_ACCESS_TOKEN}`;

    const dead: string[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Expo push ${res.status}`);
      const json = (await res.json()) as {
        data?: { status: string; details?: { error?: string } }[];
      };
      json.data?.forEach((ticket, j) => {
        if (
          ticket.status === 'error' &&
          ticket.details?.error === 'DeviceNotRegistered'
        )
          dead.push(chunk[j].to);
      });
    }
    if (dead.length) {
      await this.prisma.pushToken.deleteMany({
        where: { token: { in: dead } },
      });
      this.logger.log(`${dead.length} jeton(s) push expiré(s) supprimé(s)`);
    }
  }

  /* ---------- Lecture ---------- */

  async list(
    userId: string,
    opts: { cursor?: string; limit?: number; group?: string },
  ) {
    const limit = clampLimit(opts.limit, 30);
    const cursor = decodeCursor<{ u: string; id: string }>(opts.cursor);
    const types = opts.group
      ? (Object.keys(GROUP) as NotificationType[]).filter(
          (t) => GROUP[t] === opts.group,
        )
      : undefined;

    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(types ? { type: { in: types } } : {}),
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(cursor.u) } },
                { updatedAt: new Date(cursor.u), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);

    // Acteurs et posts chargés en 2 requêtes pour toute la page (pas de N+1).
    const actorIds = [...new Set(page.flatMap((n) => n.actorIds))];
    const postIds = [
      ...new Set(page.map((n) => n.postId).filter((id): id is string => !!id)),
    ];
    const [actors, posts] = await Promise.all([
      actorIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, username: true, avatarKey: true },
          })
        : Promise.resolve(
            [] as { id: string; username: string; avatarKey: string | null }[],
          ),
      postIds.length
        ? this.prisma.post.findMany({
            where: { id: { in: postIds } },
            select: {
              id: true,
              title: true,
              thumbnailKey: true,
              author: { select: { avatarKey: true } },
            },
          })
        : Promise.resolve(
            [] as {
              id: string;
              title: string;
              thumbnailKey: string | null;
              author: { avatarKey: string | null };
            }[],
          ),
    ]);
    const actorById = new Map(actors.map((a) => [a.id, toAuthor(a)] as const));
    const postById = new Map(
      posts.map(
        (p) =>
          [
            p.id,
            {
              id: p.id,
              title: p.title,
              thumbnailUrl:
                publicUrl(p.thumbnailKey) || publicUrl(p.author.avatarKey),
            },
          ] as const,
      ),
    );

    const last = page[page.length - 1];
    return {
      items: page.map((n) => ({
        id: n.id,
        type: APP_TYPE[n.type],
        actors: n.actorIds.map((id) => actorById.get(id)).filter(Boolean),
        actorCount: n.actorCount > n.actorIds.length ? n.actorCount : undefined,
        post: n.postId ? postById.get(n.postId) : undefined,
        text: n.text ?? undefined,
        rank: n.rank ?? undefined,
        createdAt: n.updatedAt.toISOString(),
        read: n.read,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ u: last.updatedAt.toISOString(), id: last.id })
          : null,
    } satisfies Page<unknown>;
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }
}
