import { Injectable } from '@nestjs/common';

import { addDays, monthKey, weekRange, weekStart } from '../common/time';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

export const BADGES = [
  {
    id: 'first',
    name: 'Premier pas',
    description: 'Publier sa première prise de parole',
    icon: 'footsteps',
    color: '#4AA8FF',
  },
  {
    id: 'streak4',
    name: 'Régulier',
    description: '4 semaines de série',
    icon: 'flame',
    color: '#F08A24',
  },
  {
    id: 'theme',
    name: 'Dans le thème',
    description: 'Participer à 3 thèmes',
    icon: 'flag',
    color: '#7C5CFF',
  },
  {
    id: 'podium',
    name: 'Podium',
    description: 'Finir dans le top 3 d’un thème',
    icon: 'trophy',
    color: '#F5B83D',
  },
  {
    id: 'convince',
    name: 'Convaincant',
    description: 'Recevoir 100 votes « Convaincu »',
    icon: 'checkmark-done-circle',
    color: '#22B07D',
  },
  {
    id: 'coach',
    name: 'Élève appliqué',
    description: 'Faire 10 analyses avec le coach IA',
    icon: 'sparkles',
    color: '#E14D8A',
  },
  {
    id: 'streak12',
    name: 'Inarrêtable',
    description: '12 semaines de série',
    icon: 'rocket',
    color: '#FF5A5F',
  },
] as const;

export type BadgeId = (typeof BADGES)[number]['id'];

/** Gels accumulables au maximum (Premium uniquement). */
export const MAX_FREEZES = 2;

@Injectable()
export class ProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ---------- Série ---------- */

  /** Une prise de parole (publique ou coach IA) compte pour la semaine en cours. */
  async recordActivity(userId: string, at = new Date()) {
    const week = weekStart(at);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { streakCurrent: true, streakBest: true, streakLastWeek: true },
    });
    if (!user) return;
    const last = user.streakLastWeek?.getTime();
    if (last === week.getTime()) return;

    const continues = last === addDays(week, -7).getTime();
    const current = continues ? user.streakCurrent + 1 : 1;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          streakCurrent: current,
          streakBest: Math.max(user.streakBest, current),
          streakLastWeek: week,
        },
      }),
      this.prisma.streakWeek.upsert({
        where: { userId_weekStart: { userId, weekStart: week } },
        create: { userId, weekStart: week, status: 'POSTED' },
        update: { status: 'POSTED' },
      }),
    ]);
    if (current >= 4) await this.award(userId, 'streak4');
    if (current >= 12) await this.award(userId, 'streak12');
  }

  /**
   * Lundi : clôture de la semaine écoulée. Sans post, un gel (Premium) sauve la série,
   * sinon elle retombe à 0.
   */
  async closeWeek(now = new Date()) {
    const thisWeek = weekStart(now);
    const lastWeek = addDays(thisWeek, -7);

    const atRisk = await this.prisma.user.findMany({
      where: {
        streakCurrent: { gt: 0 },
        OR: [{ streakLastWeek: null }, { streakLastWeek: { lt: lastWeek } }],
      },
      select: { id: true, streakFreezes: true, premiumUntil: true },
    });
    for (const u of atRisk) {
      const premium = !!u.premiumUntil && u.premiumUntil > now;
      if (premium && u.streakFreezes > 0) {
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: u.id },
            data: { streakFreezes: { decrement: 1 }, streakLastWeek: lastWeek },
          }),
          this.prisma.streakWeek.upsert({
            where: { userId_weekStart: { userId: u.id, weekStart: lastWeek } },
            create: { userId: u.id, weekStart: lastWeek, status: 'FROZEN' },
            update: {},
          }),
        ]);
      } else {
        await this.prisma.user.update({
          where: { id: u.id },
          data: { streakCurrent: 0 },
        });
      }
    }
    // L'historique au-delà de 8 semaines n'est plus affiché.
    await this.prisma.streakWeek.deleteMany({
      where: { weekStart: { lt: addDays(thisWeek, -7 * 10) } },
    });
  }

  /** 1 gel par mois pour les abonnés Premium (plafonné). */
  async grantMonthlyFreezes(now = new Date()) {
    const month = monthKey(now);
    await this.prisma.user.updateMany({
      where: {
        premiumUntil: { gt: now },
        streakFreezes: { lt: MAX_FREEZES },
        OR: [
          { freezeGrantedMonth: null },
          { freezeGrantedMonth: { not: month } },
        ],
      },
      data: { streakFreezes: { increment: 1 }, freezeGrantedMonth: month },
    });
  }

  /** Samedi : rappel aux personnes qui n'ont pas encore posté cette semaine. */
  async remindStreakAtRisk(now = new Date()) {
    const week = weekStart(now);
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        streakCurrent: { gt: 0 },
        streakLastWeek: { lt: week },
      },
      select: { id: true, streakCurrent: true },
    });
    for (const u of users) {
      await this.notifications.notify({
        userId: u.id,
        type: 'STREAK_RISK',
        text: `Ta série de ${u.streakCurrent} semaine${u.streakCurrent > 1 ? 's' : ''} est en danger : poste avant dimanche soir !`,
      });
    }
  }

  async streakOf(
    userId: string,
    user: {
      streakCurrent: number;
      streakBest: number;
      streakFreezes: number;
      streakLastWeek: Date | null;
    },
  ) {
    const thisWeek = weekStart();
    const weeks = await this.prisma.streakWeek.findMany({
      where: { userId, weekStart: { gte: addDays(thisWeek, -7 * 7) } },
      select: { weekStart: true, status: true },
    });
    const byWeek = new Map(weeks.map((w) => [w.weekStart.getTime(), w.status]));
    const lastWeek = addDays(thisWeek, -7).getTime();
    // Série affichée : encore valable si la dernière semaine comptée est celle-ci ou la précédente.
    const alive =
      !!user.streakLastWeek && user.streakLastWeek.getTime() >= lastWeek;
    return {
      current: alive ? user.streakCurrent : 0,
      best: user.streakBest,
      freezes: user.streakFreezes,
      postedThisWeek: user.streakLastWeek?.getTime() === thisWeek.getTime(),
      weekEndsAt: weekRange().end.toISOString(),
      history: Array.from({ length: 8 }, (_, i) => {
        const status = byWeek.get(addDays(thisWeek, -7 * (7 - i)).getTime());
        return status === 'POSTED'
          ? 'posted'
          : status === 'FROZEN'
            ? 'frozen'
            : 'missed';
      }),
    };
  }

  /* ---------- Badges ---------- */

  async award(userId: string, badgeId: BadgeId) {
    const { count } = await this.prisma.userBadge.createMany({
      data: [{ userId, badgeId }],
      skipDuplicates: true,
    });
    if (count) {
      const badge = BADGES.find((b) => b.id === badgeId)!;
      await this.notifications.notify({
        userId,
        type: 'BADGE',
        text: badge.name,
      });
    }
  }

  async checkPostBadges(userId: string) {
    await this.award(userId, 'first');
    const themes = await this.prisma.post.findMany({
      where: { authorId: userId, status: 'PUBLISHED', themeId: { not: null } },
      select: { themeId: true },
      distinct: ['themeId'],
      take: 3,
    });
    if (themes.length >= 3) await this.award(userId, 'theme');
  }

  async checkCoachBadge(userId: string) {
    const done = await this.prisma.analysis.count({
      where: { userId, status: 'DONE' },
    });
    if (done >= 10) await this.award(userId, 'coach');
  }

  async badgesOf(userId: string) {
    const unlocked = new Set(
      (
        await this.prisma.userBadge.findMany({
          where: { userId },
          select: { badgeId: true },
        })
      ).map((b) => b.badgeId),
    );
    return BADGES.map((b) => ({ ...b, unlocked: unlocked.has(b.id) }));
  }
}
