import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { OpenAiService } from '../ai/openai.service';
import { POST_CARD_SELECT, PostRow, toPost, toTheme } from '../common/mappers';
import { monthRange, weekRange } from '../common/time';
import { ThemePeriod } from '../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';

/** Sujets de secours si GPT ne répond pas. */
const FALLBACK_SUBJECTS = [
  'Faut-il rendre le service civique obligatoire ?',
  'Les réseaux sociaux nous rendent-ils plus seuls ?',
  'Doit-on supprimer les notes à l’école ?',
  'L’échec est-il nécessaire pour réussir ?',
  'Faut-il interdire la publicité pour les jeunes ?',
  'Le sport devrait-il compter autant que les maths ?',
  'Vaut-il mieux être aimé ou respecté ?',
  'Faut-il apprendre à coder dès le primaire ?',
];

const SUBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: {
      type: 'string',
      description: 'Le sujet, sous forme de question, 90 caractères maximum.',
    },
  },
  required: ['subject'],
};

@Injectable()
export class ThemesService {
  private readonly logger = new Logger('Themes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
    private readonly notifications: NotificationsService,
    private readonly progress: ProgressService,
  ) {}

  private range(period: ThemePeriod, date: Date) {
    return period === 'WEEKLY' ? weekRange(date) : monthRange(date);
  }

  /* ---------- Cycle de vie (appelé par le planificateur) ---------- */

  /**
   * S'assure que le thème en cours et le suivant existent. Le suivant est proposé par GPT
   * à l'avance : l'admin a le temps de le relire ou de le remplacer avant son ouverture.
   */
  async ensureUpcoming(now = new Date()) {
    for (const period of ['WEEKLY', 'MONTHLY'] as const) {
      const current = this.range(period, now);
      const next = this.range(period, current.end);
      for (const r of [current, next]) {
        const exists = await this.prisma.theme.count({
          where: { period, startsAt: r.start },
        });
        if (exists) continue;
        const subject = await this.generateSubject(period);
        await this.prisma.theme
          .create({
            data: {
              period,
              subject,
              startsAt: r.start,
              endsAt: r.end,
              aiGenerated: true,
            },
          })
          .catch(() => undefined); // créé entre-temps par une autre instance
      }
    }
  }

  private async generateSubject(period: ThemePeriod) {
    const recent = await this.prisma.theme.findMany({
      orderBy: { startsAt: 'desc' },
      take: 30,
      select: { subject: true },
    });
    try {
      const res = await this.openai.json<{ subject: string }>({
        userId: 'system',
        name: 'theme_subject',
        system:
          'Tu proposes des sujets d’éloquence pour VHOA, une app où des jeunes de 15 à 25 ans s’entraînent à la prise de parole. ' +
          'Le sujet est une question en français, ouverte au débat (on peut défendre les deux camps), concrète, actuelle, ' +
          'sans politique partisane ni sujet choquant, compréhensible par un lycéen.',
        user:
          `Propose un sujet pour le thème ${period === 'WEEKLY' ? 'de la semaine (léger, inspirant)' : 'du mois (plus ambitieux)'}.\n` +
          `Sujets déjà utilisés, à ne pas répéter :\n${recent.map((t) => `- ${t.subject}`).join('\n')}`,
        schema: SUBJECT_SCHEMA,
        maxOutputTokens: 800,
      });
      const subject = res.subject.trim().slice(0, 140);
      if (subject.length >= 10) return subject;
    } catch (e) {
      this.logger.warn(
        `Génération du sujet impossible : ${(e as Error).message}`,
      );
    }
    const used = new Set(recent.map((t) => t.subject));
    return (
      FALLBACK_SUBJECTS.find((s) => !used.has(s)) ??
      FALLBACK_SUBJECTS[Math.floor(Math.random() * FALLBACK_SUBJECTS.length)]
    );
  }

  /** Ouvre les thèmes dont la date est arrivée et prévient tout le monde. */
  async activateDue(now = new Date()) {
    const due = await this.prisma.theme.findMany({
      where: {
        status: 'SCHEDULED',
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
    });
    for (const theme of due) {
      const { count } = await this.prisma.theme.updateMany({
        where: { id: theme.id, status: 'SCHEDULED' },
        data: { status: 'ACTIVE' },
      });
      if (count) await this.notifications.broadcast('THEME_NEW', theme.subject);
    }
    // Thèmes jamais ouverts et déjà dépassés (serveur arrêté) : on les ferme directement.
    await this.prisma.theme.updateMany({
      where: { status: 'SCHEDULED', endsAt: { lte: now } },
      data: { status: 'CLOSED' },
    });
  }

  /** Ferme les thèmes terminés : podium, alertes et badges. */
  async closeDue(now = new Date()) {
    const due = await this.prisma.theme.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: now } },
    });
    for (const theme of due) {
      const { count } = await this.prisma.theme.updateMany({
        where: { id: theme.id, status: 'ACTIVE' },
        data: { status: 'CLOSED' },
      });
      if (!count) continue;

      const top = await this.prisma.post.findMany({
        where: {
          themeId: theme.id,
          status: 'PUBLISHED',
          convincedCount: { gt: 0 },
        },
        orderBy: [{ convincedCount: 'desc' }, { publishedAt: 'asc' }],
        take: 3,
        select: { id: true, authorId: true, convincedCount: true },
      });
      await this.prisma.themeWinner.createMany({
        data: top.map((p, i) => ({
          themeId: theme.id,
          rank: i + 1,
          postId: p.id,
          votes: p.convincedCount,
        })),
        skipDuplicates: true,
      });

      const winners = new Map(top.map((p, i) => [p.authorId, i + 1]));
      for (const [authorId, rank] of winners) {
        await this.notifications.notify({
          userId: authorId,
          type: 'THEME_RESULT',
          text: theme.subject,
          rank,
        });
        await this.progress.award(authorId, 'podium');
      }
      // Les autres participants reçoivent les résultats.
      const participants = await this.prisma.post.findMany({
        where: {
          themeId: theme.id,
          status: 'PUBLISHED',
          authorId: { notIn: [...winners.keys()] },
        },
        select: { authorId: true },
        distinct: ['authorId'],
      });
      for (const p of participants) {
        await this.notifications.notify({
          userId: p.authorId,
          type: 'THEME_RESULT',
          text: theme.subject,
        });
      }
      this.logger.log(
        `Thème clos : « ${theme.subject} » (${top.length} gagnant(s))`,
      );
    }
  }

  /* ---------- Lecture ---------- */

  async current() {
    const [weekly, monthly] = await Promise.all([
      this.prisma.theme.findFirst({
        where: { status: 'ACTIVE', period: 'WEEKLY' },
        orderBy: { startsAt: 'desc' },
      }),
      this.prisma.theme.findFirst({
        where: { status: 'ACTIVE', period: 'MONTHLY' },
        orderBy: { startsAt: 'desc' },
      }),
    ]);
    return {
      weekly: weekly ? toTheme(weekly) : null,
      monthly: monthly ? toTheme(monthly) : null,
    };
  }

  async get(id: string) {
    const theme = await this.prisma.theme.findUnique({
      where: { id },
      include: {
        winners: {
          orderBy: { rank: 'asc' },
          include: { post: { select: POST_CARD_SELECT } },
        },
      },
    });
    if (!theme || theme.status === 'SCHEDULED')
      throw new NotFoundException('Thème introuvable');
    return {
      theme: toTheme(theme),
      winners: theme.winners.map((w) => ({
        rank: w.rank,
        votes: w.votes,
        post: toPost(w.post as PostRow),
      })),
    };
  }

  /** Défis terminés (semaine et mois), du plus récent au plus ancien, avec leur podium. */
  async recent(limitRaw?: number) {
    const take = Math.min(Math.max(limitRaw ?? 8, 1), 20);
    const themes = await this.prisma.theme.findMany({
      where: { status: 'CLOSED' },
      orderBy: { endsAt: 'desc' },
      take,
      include: {
        winners: {
          orderBy: { rank: 'asc' },
          include: { post: { select: POST_CARD_SELECT } },
        },
      },
    });
    return themes.map((theme) => ({
      theme: toTheme(theme),
      winners: theme.winners.map((w) => ({
        rank: w.rank,
        votes: w.votes,
        post: toPost(w.post as PostRow),
      })),
    }));
  }

  /* ---------- Admin ---------- */

  list(status?: string) {
    const valid = ['SCHEDULED', 'ACTIVE', 'CLOSED'].includes(status ?? '')
      ? (status as 'SCHEDULED')
      : undefined;
    return this.prisma.theme.findMany({
      where: valid ? { status: valid } : {},
      orderBy: { startsAt: 'desc' },
      take: 100,
    });
  }

  /** Crée ou remplace le thème d'une période (semaine ou mois contenant `startsAt`). */
  async upsertForPeriod(period: ThemePeriod, date: Date, subject: string) {
    const r = this.range(period, date);
    if (r.end <= new Date())
      throw new BadRequestException('Cette période est déjà terminée');
    const existing = await this.prisma.theme.findUnique({
      where: { period_startsAt: { period, startsAt: r.start } },
    });
    if (existing && existing.status !== 'SCHEDULED') {
      throw new ConflictException(
        'Ce thème a déjà commencé : modifie son sujet plutôt que de le remplacer',
      );
    }
    return this.prisma.theme.upsert({
      where: { period_startsAt: { period, startsAt: r.start } },
      create: {
        period,
        subject,
        startsAt: r.start,
        endsAt: r.end,
        aiGenerated: false,
      },
      update: { subject, aiGenerated: false },
    });
  }

  async updateSubject(id: string, subject: string) {
    const theme = await this.prisma.theme.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!theme) throw new NotFoundException('Thème introuvable');
    if (theme.status === 'CLOSED')
      throw new ConflictException('Ce thème est terminé');
    return this.prisma.theme.update({
      where: { id },
      data: { subject, aiGenerated: false },
    });
  }

  async regenerate(id: string) {
    const theme = await this.prisma.theme.findUnique({ where: { id } });
    if (!theme) throw new NotFoundException('Thème introuvable');
    if (theme.status !== 'SCHEDULED')
      throw new ConflictException('Seul un thème à venir peut être régénéré');
    return this.prisma.theme.update({
      where: { id },
      data: {
        subject: await this.generateSubject(theme.period),
        aiGenerated: true,
      },
    });
  }
}
