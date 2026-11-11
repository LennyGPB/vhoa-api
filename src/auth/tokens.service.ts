import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { AccessPayload } from '../common/guards';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 60 * 24 * 3600_000;
/** Deux rafraîchissements quasi simultanés (onglet + tâche de fond) ne sont pas une attaque. */
const REUSE_GRACE_MS = 15_000;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Jeton d'accès court (15 min, JWT signé) + jeton de renouvellement long (60 j, opaque).
 * Le jeton de renouvellement change à chaque utilisation ; réutiliser un ancien jeton
 * (signe de vol) révoque toute la session.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private signAccess(userId: string, tokenVersion: number) {
    return this.jwt.signAsync({
      sub: userId,
      ver: tokenVersion,
    } satisfies AccessPayload);
  }

  private async createRefresh(
    userId: string,
    familyId: string,
    userAgent?: string,
  ) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: userAgent?.slice(0, 200),
      },
    });
    return token;
  }

  async issue(user: { id: string; tokenVersion: number }, userAgent?: string) {
    const [accessToken, refreshToken] = await Promise.all([
      this.signAccess(user.id, user.tokenVersion),
      this.createRefresh(user.id, randomUUID(), userAgent),
    ]);
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  async rotate(refreshToken: string, userAgent?: string) {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: {
        user: { select: { id: true, tokenVersion: true, status: true } },
      },
    });
    if (
      !row ||
      row.revokedAt ||
      row.expiresAt < new Date() ||
      row.user.status !== 'ACTIVE'
    ) {
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Session expirée, reconnecte-toi',
      });
    }

    // Une seule requête peut consommer le jeton (mise à jour conditionnelle atomique).
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!count) {
      const usedRecently =
        row.usedAt && Date.now() - row.usedAt.getTime() < REUSE_GRACE_MS;
      if (!usedRecently) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Session expirée, reconnecte-toi',
      });
    }

    const [accessToken, nextRefresh] = await Promise.all([
      this.signAccess(row.user.id, row.user.tokenVersion),
      this.createRefresh(row.user.id, row.familyId, userAgent),
    ]);
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  async revoke(refreshToken: string, userId: string) {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      select: { familyId: true, userId: true },
    });
    if (!row || row.userId !== userId) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAll(userId: string) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      // Les jetons d'accès en cours deviennent invalides aussi.
      this.prisma.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      }),
    ]);
  }
}
