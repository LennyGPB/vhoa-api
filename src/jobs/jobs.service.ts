import {
  Global,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Handler = (payload: any, error?: Error) => Promise<void>;

interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

/** Tâches lourdes (ffmpeg) : peu en parallèle pour ne pas saturer le CPU. Les autres : plus. */
const HEAVY = new Set(['media.process']);
const LIGHT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const POLL_MS = 15_000;
const STALE_MS = 10 * 60_000;

/**
 * File de tâches stockée dans Postgres (FOR UPDATE SKIP LOCKED) :
 * pas de Redis à payer, survit aux redémarrages, plusieurs instances possibles.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, Handler>();
  private running = { heavy: 0, light: 0 };
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  register(type: string, handler: Handler) {
    this.handlers.set(type, handler);
  }

  async enqueue(
    type: string,
    payload: Prisma.InputJsonValue,
    delayMs = 0,
    tx?: Prisma.TransactionClient,
  ) {
    await (tx ?? this.prisma).job.create({
      data: { type, payload, runAt: new Date(Date.now() + delayMs) },
    });
    // Réveille le worker tout de suite plutôt que d'attendre le prochain passage.
    if (!delayMs && !tx) this.wake();
  }

  /** À appeler après la validation d'une transaction qui a ajouté des tâches. */
  wake() {
    setImmediate(() => void this.drain());
  }

  onApplicationBootstrap() {
    if (env().NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    setTimeout(() => void this.tick(), 2_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** Remet en file les tâches bloquées (instance redémarrée en plein travail). */
  private async tick() {
    try {
      await this.prisma.job.updateMany({
        where: {
          status: 'RUNNING',
          lockedAt: { lt: new Date(Date.now() - STALE_MS) },
        },
        data: { status: 'QUEUED', lockedAt: null },
      });
    } catch (e) {
      this.logger.warn(`Récupération des tâches : ${(e as Error).message}`);
    }
    await this.drain();
  }

  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (const kind of ['heavy', 'light'] as const) {
        const limit =
          kind === 'heavy' ? env().MEDIA_CONCURRENCY : LIGHT_CONCURRENCY;
        while (this.running[kind] < limit) {
          const job = await this.claim(kind);
          if (!job) break;
          this.running[kind]++;
          void this.run(job).finally(() => {
            this.running[kind]--;
            void this.drain();
          });
        }
      }
    } catch (e) {
      this.logger.warn(`Lecture de la file : ${(e as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async claim(kind: 'heavy' | 'light'): Promise<JobRow | null> {
    const heavyTypes = [...HEAVY];
    const typeFilter =
      kind === 'heavy'
        ? Prisma.sql`AND "type" IN (${Prisma.join(heavyTypes)})`
        : Prisma.sql`AND "type" NOT IN (${Prisma.join(heavyTypes)})`;
    const rows = await this.prisma.$queryRaw<JobRow[]>`
      UPDATE "Job" SET "status" = 'RUNNING', "lockedAt" = now(), "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "Job"
        WHERE "status" = 'QUEUED' AND "runAt" <= now() ${typeFilter}
        ORDER BY "runAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "type", "payload", "attempts"`;
    return rows[0] ?? null;
  }

  private async run(job: JobRow) {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`Aucun gestionnaire pour ${job.type}`);
      await handler(job.payload);
      await this.prisma.job.delete({ where: { id: job.id } });
    } catch (e) {
      const message = (e as Error).message?.slice(0, 480) ?? 'Erreur';
      const final =
        job.attempts >= MAX_ATTEMPTS ||
        (e as { permanent?: boolean }).permanent;
      this.logger.warn(
        `${job.type} (${job.id}) essai ${job.attempts} : ${message}`,
      );
      await this.prisma.job
        .update({
          where: { id: job.id },
          data: final
            ? { status: 'FAILED', lastError: message, lockedAt: null }
            : {
                status: 'QUEUED',
                lastError: message,
                lockedAt: null,
                runAt: new Date(Date.now() + 30_000 * 4 ** (job.attempts - 1)),
              },
        })
        .catch(() => undefined);
      if (final) {
        const onFail = this.handlers.get(`${job.type}:failed`);
        await onFail?.(job.payload, e as Error).catch(() => undefined);
      }
    }
  }
}

/** Erreur qui ne sert à rien de réessayer (fichier invalide, trop long…). */
export class PermanentJobError extends Error {
  readonly permanent = true;
}

@Global()
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
