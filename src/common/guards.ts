import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';

import { env } from '../config/env';
import { Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedRequest, AuthUser, IS_PUBLIC, ROLES } from './auth.decorators';
import { TtlCache } from './ttl-cache';

export interface AccessPayload {
  sub: string;
  ver: number;
}

interface CachedUser {
  role: Role;
  banned: boolean;
  tokenVersion: number;
  premiumUntil: Date | null;
}

/**
 * Vérifie le jeton d'accès sur toutes les routes (sauf @Public).
 * L'état du compte (banni, jetons révoqués) est relu en base au plus toutes les 30 s.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private static readonly users = new TtlCache<CachedUser | null>(
    30_000,
    20_000,
  );

  /** À appeler après un bannissement, une déconnexion globale ou un changement d'abonnement. */
  static invalidate(userId: string) {
    JwtAuthGuard.users.delete(userId);
  }

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7).trim()
      : undefined;

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Connexion requise');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token, {
        algorithms: ['HS256'],
      });
    } catch {
      // Sur une route publique, un jeton expiré ne doit pas bloquer (ex. inscription).
      if (isPublic) return true;
      throw new UnauthorizedException('Session expirée');
    }

    const user = await JwtAuthGuard.users.wrap(payload.sub, async () => {
      const row = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          role: true,
          status: true,
          tokenVersion: true,
          premiumUntil: true,
        },
      });
      return row
        ? {
            role: row.role,
            banned: row.status === 'BANNED',
            tokenVersion: row.tokenVersion,
            premiumUntil: row.premiumUntil,
          }
        : null;
    });

    if (!user || user.tokenVersion !== payload.ver) {
      if (isPublic) return true;
      throw new UnauthorizedException('Session expirée');
    }
    if (user.banned)
      throw new ForbiddenException({
        code: 'ACCOUNT_BANNED',
        message: 'Compte suspendu',
      });

    req.user = {
      id: payload.sub,
      role: user.role,
      isPremium:
        !!user.premiumUntil && user.premiumUntil.getTime() > Date.now(),
    } satisfies AuthUser;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !roles.includes(user.role))
      throw new ForbiddenException('Accès refusé');
    return true;
  }
}

/**
 * IP du visiteur transmise par le serveur du site web (vhoa-web), qui appelle l'API à sa place.
 * Acceptée uniquement avec la bonne clé BFF_SECRET (comparaison en temps constant) :
 * personne d'autre ne peut se faire passer pour une autre IP.
 */
function forwardedClientIp(req: {
  headers?: Record<string, string | string[] | undefined>;
}): string | null {
  const secret = env().BFF_SECRET;
  if (!secret) return null;
  const key = req.headers?.['x-vhoa-bff-key'];
  const ip = req.headers?.['x-vhoa-client-ip'];
  if (typeof key !== 'string' || typeof ip !== 'string') return null;
  const a = Buffer.from(key);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return isIP(ip) ? ip : null;
}

/** Limite par utilisateur connecté, sinon par adresse IP (derrière le proxy Railway ou le site web). */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const user = (req as AuthedRequest).user;
    if (user) return Promise.resolve(`u:${user.id}`);
    const ip = forwardedClientIp(req) ?? (req as AuthedRequest).ip ?? 'unknown';
    return Promise.resolve(`ip:${ip}`);
  }
}
