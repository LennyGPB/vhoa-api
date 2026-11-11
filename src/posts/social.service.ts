import { Injectable } from '@nestjs/common';

import { TtlCache } from '../common/ttl-cache';
import { PostRow, ViewerState } from '../common/mappers';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Données « relationnelles » partagées par le feed, les profils et les posts :
 * blocages et état du lecteur (aimé, enregistré…), chargés par lots.
 */
@Injectable()
export class SocialService {
  private readonly blocks = new TtlCache<string[]>(20_000, 20_000);

  constructor(private readonly prisma: PrismaService) {}

  /** Personnes bloquées par l'utilisateur ou qui l'ont bloqué. */
  hiddenUserIds(userId: string): Promise<string[]> {
    return this.blocks.wrap(userId, async () => {
      const rows = await this.prisma.block.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      });
      return [
        ...new Set(
          rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)),
        ),
      ];
    });
  }

  invalidateBlocks(...userIds: string[]) {
    userIds.forEach((id) => this.blocks.delete(id));
  }

  async isHidden(viewerId: string, otherId: string) {
    return (await this.hiddenUserIds(viewerId)).includes(otherId);
  }

  /** État du lecteur pour une page de posts : 4 requêtes au total, quel que soit le nombre de posts. */
  async viewerStates(
    viewerId: string,
    posts: Pick<PostRow, 'id' | 'author'>[],
  ): Promise<Map<string, ViewerState>> {
    const postIds = posts.map((p) => p.id);
    const authorIds = [...new Set(posts.map((p) => p.author.id))];
    if (!postIds.length) return new Map();

    const [likes, saves, convinced, follows] = await Promise.all([
      this.prisma.like.findMany({
        where: { userId: viewerId, postId: { in: postIds } },
        select: { postId: true },
      }),
      this.prisma.save.findMany({
        where: { userId: viewerId, postId: { in: postIds } },
        select: { postId: true },
      }),
      this.prisma.convinced.findMany({
        where: { userId: viewerId, postId: { in: postIds } },
        select: { postId: true },
      }),
      this.prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: authorIds } },
        select: { followingId: true },
      }),
    ]);
    const liked = new Set(likes.map((l) => l.postId));
    const saved = new Set(saves.map((s) => s.postId));
    const voted = new Set(convinced.map((c) => c.postId));
    const following = new Set(follows.map((f) => f.followingId));

    return new Map(
      posts.map((p) => [
        p.id,
        {
          isLiked: liked.has(p.id),
          isSaved: saved.has(p.id),
          isConvinced: voted.has(p.id),
          isFollowingAuthor: following.has(p.author.id),
        },
      ]),
    );
  }
}
