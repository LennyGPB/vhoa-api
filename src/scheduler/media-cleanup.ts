import { Injectable } from '@nestjs/common';

import { StorageService } from '../media/storage.service';
import { PrismaService } from '../prisma/prisma.service';

/** Envois commencés puis abandonnés (app fermée…) : on libère la place sur R2. */
@Injectable()
export class MediaCleanup {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async abandonedUploads() {
    const stale = await this.prisma.post.findMany({
      where: {
        status: 'UPLOADING',
        createdAt: { lt: new Date(Date.now() - 60 * 60_000) },
      },
      select: { id: true, mediaPrefix: true },
      take: 500,
    });
    for (const post of stale) {
      await this.storage
        .deletePrefix(`${post.mediaPrefix}/`)
        .catch(() => undefined);
      await this.prisma.post
        .delete({ where: { id: post.id } })
        .catch(() => undefined);
    }
  }
}
