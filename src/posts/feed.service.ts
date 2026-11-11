import { Injectable } from '@nestjs/common';

import { CoachService } from '../coach/coach.service';
import { AuthUser } from '../common/auth.decorators';
import { clampLimit, decodeCursor, encodeCursor } from '../common/cursor';
import {
  CATEGORY_VALUES,
  POST_CARD_SELECT,
  POST_SELECT,
  PostRow,
  toAuthor,
  toFeedPost,
  toPost,
  toTheme,
} from '../common/mappers';
import { TtlCache } from '../common/ttl-cache';
import { addDays } from '../common/time';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SocialService } from './social.service';

/** Les posts déjà vus pendant cette période passent après les nouveaux. */
const SEEN_WINDOW_DAYS = 7;

interface ForYouCursor extends Record<string, unknown> {
  /** 0 : posts pas encore vus ; 1 : tout le reste. */
  ph: 0 | 1;
  s?: number;
  id?: string;
}

@Injectable()
export class FeedService {
  /** Partie commune de l'écran Explorer, identique pour tout le monde : mise en cache 60 s. */
  private readonly exploreCache = new TtlCache<
    Awaited<ReturnType<FeedService['loadExploreShared']>>
  >(60_000, 4);

  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
    private readonly coach: CoachService,
  ) {}

  private async page(viewerId: string, posts: PostRow[]) {
    const states = await this.social.viewerStates(viewerId, posts);
    return posts.map((p) => toFeedPost(p, states.get(p.id)!));
  }

  /**
   * « Pour toi » : classement par score tendance (engagement / ancienneté).
   * Phase 0 : posts pas vus depuis 7 jours. Quand il n'y en a plus, phase 1 : les déjà vus.
   * Les deux ensembles sont disjoints, donc jamais de doublon. Pagination par curseur (score, id).
   */
  async forYou(viewerId: string, cursorStr?: string, limitRaw?: number) {
    const limit = clampLimit(limitRaw, 8, 20);
    const cursor = decodeCursor<ForYouCursor>(cursorStr) ?? { ph: 0 };
    const hidden = await this.social.hiddenUserIds(viewerId);
    const seen = {
      userId: viewerId,
      viewedAt: { gte: addDays(new Date(), -SEEN_WINDOW_DAYS) },
    };

    const base: Prisma.PostWhereInput = {
      status: 'PUBLISHED',
      authorId: { notIn: [viewerId, ...hidden] },
      notInterested: { none: { userId: viewerId } },
    };
    const after = (c: ForYouCursor): Prisma.PostWhereInput =>
      c.s === undefined
        ? {}
        : {
            OR: [
              { hotScore: { lt: c.s } },
              { hotScore: c.s, id: { lt: c.id } },
            ],
          };
    const query = async (where: Prisma.PostWhereInput, take: number) =>
      (await this.prisma.post.findMany({
        where,
        orderBy: [{ hotScore: 'desc' }, { id: 'desc' }],
        take,
        select: { ...POST_SELECT, hotScore: true },
      })) as (PostRow & { hotScore: number })[];
    const cursorOf = (ph: 0 | 1, p: PostRow & { hotScore: number }) =>
      encodeCursor({ ph, s: p.hotScore, id: p.id });

    const items: (PostRow & { hotScore: number })[] = [];
    if (cursor.ph === 0) {
      const rows = await query(
        { ...base, views: { none: seen }, ...after(cursor) },
        limit + 1,
      );
      items.push(...rows.slice(0, limit));
      if (rows.length > limit) {
        return {
          items: await this.page(viewerId, items),
          nextCursor: cursorOf(0, items[items.length - 1]),
        };
      }
    }

    const need = limit - items.length;
    const rows = await query(
      {
        ...base,
        views: { some: seen },
        ...(cursor.ph === 1 ? after(cursor) : {}),
      },
      need + 1,
    );
    const added = rows.slice(0, need);
    items.push(...added);
    const last = added[added.length - 1];
    return {
      items: await this.page(viewerId, items),
      nextCursor: rows.length > need && last ? cursorOf(1, last) : null,
    };
  }

  /** « Abonnements » : posts des comptes suivis, du plus récent au plus ancien. */
  async following(viewerId: string, cursorStr?: string, limitRaw?: number) {
    const limit = clampLimit(limitRaw, 8, 20);
    const cursor = decodeCursor<{ p: string; id: string }>(cursorStr);
    const rows = (await this.prisma.post.findMany({
      where: {
        status: 'PUBLISHED',
        author: { followers: { some: { followerId: viewerId } } },
        ...(cursor
          ? {
              OR: [
                { publishedAt: { lt: new Date(cursor.p) } },
                { publishedAt: new Date(cursor.p), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: POST_SELECT,
    })) as PostRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.page(viewerId, page),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ p: last.publishedAt!.toISOString(), id: last.id })
          : null,
    };
  }

  /** Posts d'un thème, classés par votes « Convaincu ». */
  async themePosts(
    viewerId: string,
    themeId: string,
    cursorStr?: string,
    limitRaw?: number,
  ) {
    const limit = clampLimit(limitRaw, 12, 30);
    const cursor = decodeCursor<{ v: number; id: string }>(cursorStr);
    const hidden = await this.social.hiddenUserIds(viewerId);
    const rows = (await this.prisma.post.findMany({
      where: {
        themeId,
        status: 'PUBLISHED',
        ...(hidden.length ? { authorId: { notIn: hidden } } : {}),
        ...(cursor
          ? {
              OR: [
                { convincedCount: { lt: cursor.v } },
                { convincedCount: cursor.v, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ convincedCount: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: POST_SELECT,
    })) as PostRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.page(viewerId, page),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ v: last.convincedCount, id: last.id })
          : null,
    };
  }

  /* ---------- Explorer ---------- */

  private async loadExploreShared() {
    const [
      currentTheme,
      monthlyTheme,
      trending,
      recent,
      lastClosed,
      newSpeakers,
    ] = await Promise.all([
      this.prisma.theme.findFirst({
        where: { status: 'ACTIVE', period: 'WEEKLY' },
        orderBy: { startsAt: 'desc' },
      }),
      this.prisma.theme.findFirst({
        where: { status: 'ACTIVE', period: 'MONTHLY' },
        orderBy: { startsAt: 'desc' },
      }),
      this.prisma.post.findMany({
        where: {
          status: 'PUBLISHED',
          publishedAt: { gte: addDays(new Date(), -14) },
        },
        orderBy: [{ hotScore: 'desc' }, { id: 'desc' }],
        take: 12,
        select: POST_CARD_SELECT,
      }),
      this.prisma.post.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: 60,
        select: POST_CARD_SELECT,
      }),
      this.prisma.theme.findFirst({
        where: { status: 'CLOSED', period: 'WEEKLY' },
        orderBy: { endsAt: 'desc' },
        include: {
          winners: {
            orderBy: { rank: 'asc' },
            include: { post: { select: POST_CARD_SELECT } },
          },
        },
      }),
      this.prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          postsCount: { gt: 0 },
          createdAt: { gte: addDays(new Date(), -30) },
        },
        orderBy: [{ followersCount: 'desc' }, { createdAt: 'desc' }],
        take: 16,
        select: {
          id: true,
          username: true,
          avatarKey: true,
          followersCount: true,
        },
      }),
    ]);
    return {
      currentTheme,
      monthlyTheme,
      trending: trending as PostRow[],
      recent: recent as PostRow[],
      lastClosed,
      newSpeakers,
    };
  }

  /** Tout l'écran Explorer en une seule requête (moins d'allers-retours = chargement plus rapide). */
  async explore(user: AuthUser) {
    const [shared, hidden, quota] = await Promise.all([
      this.exploreCache.wrap('explore', () => this.loadExploreShared()),
      this.social.hiddenUserIds(user.id),
      this.coach.quota(user),
    ]);
    const hiddenSet = new Set(hidden);
    const visible = (p: PostRow) => !hiddenSet.has(p.author.id);

    const speakers = shared.newSpeakers
      .filter((s) => s.id !== user.id && !hiddenSet.has(s.id))
      .slice(0, 8);
    const following = new Set(
      speakers.length
        ? (
            await this.prisma.follow.findMany({
              where: {
                followerId: user.id,
                followingId: { in: speakers.map((s) => s.id) },
              },
              select: { followingId: true },
            })
          ).map((f) => f.followingId)
        : [],
    );

    return {
      currentTheme: shared.currentTheme ? toTheme(shared.currentTheme) : null,
      monthlyTheme: shared.monthlyTheme ? toTheme(shared.monthlyTheme) : null,
      aiQuota: {
        used: quota.used,
        total: quota.total,
        isPremium: quota.isPremium,
      },
      trendingPosts: shared.trending.filter(visible).slice(0, 8).map(toPost),
      posts: shared.recent.filter(visible).map(toPost),
      lastThemeResult: shared.lastClosed
        ? {
            theme: toTheme(shared.lastClosed),
            winners: shared.lastClosed.winners
              .filter((w) => visible(w.post as PostRow))
              .map((w) => ({
                rank: w.rank,
                votes: w.votes,
                post: toPost(w.post as PostRow),
              })),
          }
        : null,
      categories: CATEGORY_VALUES,
      newSpeakers: speakers.map((s) => ({
        ...toAuthor(s),
        followers: s.followersCount,
        isFollowing: following.has(s.id),
      })),
    };
  }
}
