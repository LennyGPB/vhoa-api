import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenAiService } from '../ai/openai.service';
import { Prisma } from '../generated/prisma/client';
import { JobsService, PermanentJobError } from '../jobs/jobs.service';
import {
  extractFrame,
  extractSpeech,
  MAX_SECONDS,
  probe,
  sniffFormat,
  transcodeAudio,
  transcodeVideo,
} from '../media/ffmpeg';
import { refundAnalysis } from '../coach/coach.service';
import { StorageService } from '../media/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';
import { PostLifecycleService } from './post-lifecycle.service';
import { MAX_UPLOAD_BYTES } from './posts.constants';

const MODERATION_MESSAGE = 'Contenu contraire aux règles de la communauté';

/**
 * Traitement d'un envoi : contrôle → conversion 720p → miniature → transcription → modération.
 * Le fichier brut est supprimé ensuite : seul le fichier allégé reste sur R2.
 */
@Injectable()
export class MediaProcessor implements OnModuleInit {
  private readonly logger = new Logger('Media');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly openai: OpenAiService,
    private readonly jobs: JobsService,
    private readonly lifecycle: PostLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly progress: ProgressService,
  ) {}

  onModuleInit() {
    this.jobs.register('media.process', (p: { postId: string }) =>
      this.process(p.postId),
    );
    this.jobs.register(
      'media.process:failed',
      (p: { postId: string }, error?: Error) =>
        // Seuls nos messages volontaires sont montrés à l'utilisateur, jamais une erreur technique.
        this.fail(
          p.postId,
          error instanceof PermanentJobError
            ? error.message
            : 'Le traitement a échoué, réessaie',
        ),
    );
    this.jobs.register('media.delete', (p: { prefix: string }) =>
      this.storage.deletePrefix(p.prefix),
    );
  }

  private async process(postId: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.status !== 'PROCESSING' || !post.rawKey) return;

    const dir = await mkdtemp(join(tmpdir(), 'vhoa-'));
    try {
      const input = join(dir, 'input');
      await this.storage.download(
        post.rawKey,
        input,
        MAX_UPLOAD_BYTES[post.type],
      );

      const format = await sniffFormat(input);
      if (!format)
        throw new PermanentJobError('Format de fichier non pris en charge');
      if (post.type === 'VIDEO' && format !== 'mov' && format !== 'matroska') {
        throw new PermanentJobError('Format vidéo non pris en charge');
      }
      const info = await probe(input, format).catch(() => {
        throw new PermanentJobError('Fichier illisible');
      });
      if (!info.hasAudio) throw new PermanentJobError('Aucun son détecté');
      if (post.type === 'VIDEO' && !info.hasVideo)
        throw new PermanentJobError('Aucune image détectée');
      if (info.duration > MAX_SECONDS + 1.5)
        throw new PermanentJobError('Durée maximale : 1 minute');
      if (info.duration < 2)
        throw new PermanentJobError('Prise de parole trop courte');

      const isVideo = post.type === 'VIDEO';
      const output = join(dir, isVideo ? 'media.mp4' : 'media.m4a');
      const speech = join(dir, 'speech.mp3');
      await (isVideo
        ? transcodeVideo(input, format, output)
        : transcodeAudio(input, format, output));
      await rm(input, { force: true });
      await extractSpeech(output, speech);

      const final = await probe(output);
      const duration = Math.min(MAX_SECONDS, final.duration || info.duration);

      // Miniature + 3 images pour la modération.
      const frames: string[] = [];
      let thumbPath: string | undefined;
      if (isVideo) {
        thumbPath = join(dir, 'thumb.jpg');
        await extractFrame(output, Math.min(1, duration / 2), thumbPath, 360);
        for (const ratio of [0.2, 0.5, 0.8]) {
          const frame = join(dir, `frame-${ratio}.jpg`);
          await extractFrame(output, duration * ratio, frame, 512);
          frames.push(
            `data:image/jpeg;base64,${(await readFile(frame)).toString('base64')}`,
          );
        }
      }

      const mediaKey = `${post.mediaPrefix}/${isVideo ? 'media.mp4' : 'media.m4a'}`;
      const thumbnailKey = thumbPath ? `${post.mediaPrefix}/thumb.jpg` : null;

      // Envoi d'abord, transcription ensuite : si l'envoi échoue, la nouvelle tentative
      // ne repaie pas Whisper (seul l'envoi, gratuit, est refait).
      await Promise.all([
        this.storage.upload(
          mediaKey,
          output,
          isVideo ? 'video/mp4' : 'audio/mp4',
        ),
        thumbPath
          ? this.storage.upload(thumbnailKey!, thumbPath, 'image/jpeg')
          : Promise.resolve(),
      ]);
      const transcription = await this.openai.transcribe(speech);

      const verdict = await this.openai.moderate({
        text: [post.title, post.hashtags.join(' '), transcription.text]
          .filter(Boolean)
          .join('\n'),
        images: frames,
      });
      if (verdict.flagged)
        this.logger.warn(
          `Post ${postId} signalé par la modération : ${verdict.categories.join(', ')}`,
        );

      const status =
        post.mode === 'AI'
          ? 'PRIVATE'
          : post.mode === 'DRAFT'
            ? 'DRAFT'
            : verdict.flagged
              ? 'REJECTED'
              : 'PUBLISHED';

      const { size } = await stat(output);
      this.logger.log(
        `Post ${postId} prêt (${status}, ${Math.round(duration)} s, ${Math.round(size / 1024)} Ko)`,
      );

      await this.prisma.post.update({
        where: { id: postId },
        data: {
          status,
          mediaKey,
          thumbnailKey,
          duration,
          width: final.width,
          height: final.height,
          rawKey: null,
          transcriptText: transcription.text.slice(0, 5000),
          transcript: transcription.cues,
          words: transcription.words as unknown as Prisma.InputJsonValue,
          moderationReason: verdict.flagged ? MODERATION_MESSAGE : null,
          publishedAt: status === 'PUBLISHED' ? new Date() : null,
        },
      });
      await this.storage.deleteKeys([post.rawKey]);

      if (status === 'PUBLISHED') await this.lifecycle.onPublished(postId);
      if (status === 'PRIVATE')
        await this.progress.recordActivity(post.authorId);
      if (status === 'REJECTED') {
        await this.notifications.notify({
          userId: post.authorId,
          type: 'MODERATION',
          postId,
          text: 'Ta prise de parole n’a pas été publiée : elle ne respecte pas les règles de la communauté. Tu peux contester depuis les paramètres.',
        });
      }

      // Analyses demandées pendant le traitement.
      const pending = await this.prisma.analysis.findMany({
        where: { postId, status: 'PENDING' },
        select: { id: true },
      });
      for (const a of pending)
        await this.jobs.enqueue('coach.analyze', { analysisId: a.id });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async fail(postId: string, reason: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { rawKey: true, status: true },
    });
    if (!post || post.status !== 'PROCESSING') return;
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'FAILED',
        processingError: reason.slice(0, 300),
        rawKey: null,
      },
    });
    // Analyses en attente : échouées, et leur crédit est rendu.
    const pending = await this.prisma.analysis.findMany({
      where: { postId, status: 'PENDING' },
      select: { id: true, userId: true, month: true },
    });
    await this.prisma.analysis.updateMany({
      where: { id: { in: pending.map((a) => a.id) } },
      data: { status: 'FAILED', error: 'Le fichier n’a pas pu être traité' },
    });
    for (const a of pending)
      await refundAnalysis(this.prisma, a.userId, a.month);
    if (post.rawKey)
      await this.storage.deleteKeys([post.rawKey]).catch(() => undefined);
  }
}
