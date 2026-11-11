import { Injectable } from '@nestjs/common';

import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';

/** Score « tendance » : engagement pondéré, qui décroît avec l'âge du post. */
export const HOT_SCORE_SQL = `
  ("likesCount" + 3 * "commentsCount" + 4 * "convincedCount" + 2 * "sharesCount" + 2 * "savesCount" + 1)
  / power(extract(epoch from (now() - coalesce("publishedAt", "createdAt"))) / 3600 + 2, 1.5)`;

/** Ce qui se passe quand un post devient public (après traitement ou depuis un brouillon). */
@Injectable()
export class PostLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressService,
    private readonly jobs: JobsService,
  ) {}

  async onPublished(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        authorId: true,
        themeId: true,
        theme: { select: { status: true } },
      },
    });
    if (!post) return;

    await this.prisma.user.update({
      where: { id: post.authorId },
      data: { postsCount: { increment: 1 } },
    });
    await this.prisma.$executeRawUnsafe(
      `UPDATE "Post" SET "hotScore" = ${HOT_SCORE_SQL} WHERE "id" = $1::uuid`,
      postId,
    );

    if (post.themeId) {
      if (post.theme?.status === 'ACTIVE') {
        // Une personne ne compte qu'une fois parmi les participants d'un thème.
        const others = await this.prisma.post.count({
          where: {
            themeId: post.themeId,
            authorId: post.authorId,
            status: 'PUBLISHED',
            id: { not: postId },
          },
        });
        if (!others) {
          await this.prisma.theme.update({
            where: { id: post.themeId },
            data: { participantsCount: { increment: 1 } },
          });
        }
      } else {
        // Thème terminé entre-temps : le post est publié sans participer.
        await this.prisma.post.update({
          where: { id: postId },
          data: { themeId: null },
        });
      }
    }

    await this.progress.recordActivity(post.authorId);
    await this.progress.checkPostBadges(post.authorId);
  }

  /** Retire un post publié des compteurs (suppression ou modération). */
  async onUnpublished(postId: string, authorId: string) {
    await this.prisma.user.updateMany({
      where: { id: authorId, postsCount: { gt: 0 } },
      data: { postsCount: { decrement: 1 } },
    });
  }

  /** Supprime les fichiers d'un post sur R2 (en tâche de fond). */
  async deleteMedia(mediaPrefix: string) {
    await this.jobs.enqueue('media.delete', { prefix: mediaPrefix });
  }
}
