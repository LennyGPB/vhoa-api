import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { addDays } from '../common/time';
import { env } from '../config/env';
import { HOT_SCORE_SQL } from '../posts/post-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';
import { ThemesService } from '../themes/themes.service';
import { MediaCleanup } from './media-cleanup';

const TZ = 'Europe/Paris';

/**
 * Tâches planifiées. Chacune prend un verrou en base : si plusieurs instances tournent
 * sur Railway, une seule l'exécute.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Scheduler');

  constructor(
    private readonly prisma: PrismaService,
    private readonly themes: ThemesService,
    private readonly progress: ProgressService,
    private readonly cleanup: MediaCleanup,
  ) {}

  onApplicationBootstrap() {
    if (env().NODE_ENV === 'test') return;
    // Au démarrage : thèmes prêts sans attendre la prochaine heure pile.
    setTimeout(() => void this.themesTick(), 5_000);
  }

  private async locked(
    name: string,
    ttlMs: number,
    fn: () => Promise<unknown>,
  ) {
    const now = new Date();
    const until = new Date(now.getTime() + ttlMs);
    const acquired = await this.prisma.$executeRaw`
      INSERT INTO "CronLock" ("name", "lockedUntil") VALUES (${name}, ${until})
      ON CONFLICT ("name") DO UPDATE SET "lockedUntil" = EXCLUDED."lockedUntil"
      WHERE "CronLock"."lockedUntil" < ${now}`;
    if (!acquired) return;
    try {
      await fn();
    } catch (e) {
      this.logger.error(
        `${name} : ${(e as Error).message}`,
        (e as Error).stack,
      );
    }
  }

  @Cron('5 * * * *', { timeZone: TZ })
  async themesTick() {
    await this.locked('themes', 50 * 60_000, async () => {
      await this.themes.closeDue();
      await this.themes.ensureUpcoming();
      await this.themes.activateDue();
    });
  }

  /** Score tendance des posts récents (le feed « Pour toi » se lit ensuite sans calcul). */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async hotScores() {
    await this.locked('hot-scores', 8 * 60_000, () =>
      this.prisma.$executeRawUnsafe(
        `UPDATE "Post" SET "hotScore" = ${HOT_SCORE_SQL}
         WHERE "status" = 'PUBLISHED' AND "publishedAt" > now() - interval '30 days'`,
      ),
    );
  }

  @Cron('10 0 * * 1', { timeZone: TZ })
  async weeklyStreaks() {
    await this.locked('streak-close', 60 * 60_000, () =>
      this.progress.closeWeek(),
    );
  }

  @Cron('0 18 * * 6', { timeZone: TZ })
  async streakReminder() {
    await this.locked('streak-reminder', 60 * 60_000, () =>
      this.progress.remindStreakAtRisk(),
    );
  }

  @Cron('30 3 * * *', { timeZone: TZ })
  async daily() {
    await this.locked('daily', 60 * 60_000, async () => {
      await this.progress.grantMonthlyFreezes();
      const now = new Date();
      await this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { revokedAt: { lt: addDays(now, -7) } },
          ],
        },
      });
      await this.prisma.postView.deleteMany({
        where: { viewedAt: { lt: addDays(now, -30) } },
      });
      await this.prisma.notification.deleteMany({
        where: { read: true, updatedAt: { lt: addDays(now, -90) } },
      });
      await this.prisma.job.deleteMany({
        where: { status: 'FAILED', createdAt: { lt: addDays(now, -14) } },
      });
      await this.prisma.billingEvent.deleteMany({
        where: { createdAt: { lt: addDays(now, -90) } },
      });
    });
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async abandonedUploads() {
    await this.locked('abandoned-uploads', 25 * 60_000, () =>
      this.cleanup.abandonedUploads(),
    );
  }
}
