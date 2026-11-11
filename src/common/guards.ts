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

/** Limite par utilisateur connecté, sinon par adresse IP (derrière le proxy Railway). */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const user = (req as AuthedRequest).user;
    return Promise.resolve(
      user ? `u:${user.id}` : `ip:${(req as AuthedRequest).ip ?? 'unknown'}`,
    );
  }
}
