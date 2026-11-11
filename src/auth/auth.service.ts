import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';

import { OpenAiService } from '../ai/openai.service';
import { JwtAuthGuard } from '../common/guards';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import {
  AppleAuthDto,
  ChangePasswordDto,
  GoogleAuthDto,
  LoginDto,
  RegisterDto,
  RESERVED_USERNAMES,
  USERNAME_RE,
} from './auth.dto';
import {
  SocialIdentity,
  SocialVerifierService,
} from './social-verifier.service';
import { TokensService } from './tokens.service';

/** Paramètres argon2id recommandés par l'OWASP (19 Mio, 2 passes). */
const HASH_OPTIONS = {
  type: argon2.argon2id as 0 | 1 | 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;

const ageRequired = () =>
  new ForbiddenException({
    code: 'AGE_CONFIRMATION_REQUIRED',
    message: 'Tu dois avoir 15 ans ou plus pour utiliser VHOA',
  });

@Injectable()
export class AuthService implements OnModuleInit {
  /** Hash factice : un email inconnu prend autant de temps qu'un mauvais mot de passe. */
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly social: SocialVerifierService,
    private readonly users: UsersService,
    private readonly openai: OpenAiService,
  ) {}

  async onModuleInit() {
    this.dummyHash = await argon2.hash('vhoa-dummy-password', HASH_OPTIONS);
  }

  private async session(
    user: { id: string; tokenVersion: number },
    userAgent?: string,
  ) {
    const [tokens, me] = await Promise.all([
      this.tokens.issue(user, userAgent),
      this.users.me(user.id),
    ]);
    return { ...tokens, user: me };
  }

  async usernameAvailable(username: string) {
    const u = username.trim().toLowerCase();
    if (!USERNAME_RE.test(u) || RESERVED_USERNAMES.has(u))
      return { available: false };
    return {
      available: !(await this.prisma.user.count({ where: { username: u } })),
    };
  }

  private async assertCleanIdentity(username: string, displayName: string) {
    const verdict = await this.openai.moderate({
      text: `${username}\n${displayName}`,
    });
    if (verdict.flagged) {
      throw new UnprocessableEntityException({
        code: 'CONTENT_REJECTED',
        message: 'Ce pseudo ne respecte pas les règles de la communauté',
      });
    }
  }

  async register(dto: RegisterDto, userAgent?: string) {
    if (dto.ageConfirmed !== true) throw ageRequired();
    if (RESERVED_USERNAMES.has(dto.username)) {
      throw new ConflictException({
        code: 'USERNAME_TAKEN',
        message: 'Ce pseudo est déjà pris',
      });
    }
    if (
      dto.password.toLowerCase().includes(dto.username) ||
      dto.password.toLowerCase() === dto.email
    ) {
      throw new UnprocessableEntityException({
        code: 'WEAK_PASSWORD',
        message: 'Le mot de passe ne doit pas contenir ton pseudo ou ton email',
      });
    }
    const displayName = dto.displayName || dto.username;
    await this.assertCleanIdentity(dto.username, displayName);

    const passwordHash = await argon2.hash(dto.password, HASH_OPTIONS);
    try {
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          username: dto.username,
          displayName,
          ageConfirmedAt: new Date(),
        },
        select: { id: true, tokenVersion: true },
      });
      return this.session(user, userAgent);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = JSON.stringify(
          (e.meta as { target?: unknown })?.target ?? '',
        );
        throw target.includes('username')
          ? new ConflictException({
              code: 'USERNAME_TAKEN',
              message: 'Ce pseudo est déjà pris',
            })
          : new ConflictException({
              code: 'EMAIL_TAKEN',
              message: 'Un compte existe déjà avec cet email',
            });
      }
      throw e;
    }
  }

  async login(dto: LoginDto, userAgent?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        passwordHash: true,
        tokenVersion: true,
        status: true,
        failedLogins: true,
        lockedUntil: true,
      },
    });
    const wrong = new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Email ou mot de passe incorrect',
    });

    if (!user?.passwordHash) {
      await argon2.verify(this.dummyHash, dto.password).catch(() => false);
      throw wrong;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        {
          code: 'ACCOUNT_LOCKED',
          message: 'Trop de tentatives. Réessaie dans quelques minutes.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await argon2
      .verify(user.passwordHash, dto.password)
      .catch(() => false);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data:
          failed >= MAX_FAILED_LOGINS
            ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
            : { failedLogins: failed },
      });
      throw wrong;
    }
    if (user.status === 'BANNED')
      throw new ForbiddenException({
        code: 'ACCOUNT_BANNED',
        message: 'Compte suspendu',
      });

    if (user.failedLogins || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }
    return this.session(user, userAgent);
  }

  async apple(dto: AppleAuthDto, userAgent?: string) {
    const identity = await this.social.apple(dto.identityToken, dto.nonce);
    return this.socialLogin(
      'appleSub',
      identity,
      dto.ageConfirmed,
      dto.fullName,
      userAgent,
    );
  }

  async google(dto: GoogleAuthDto, userAgent?: string) {
    const identity = await this.social.google(dto.idToken);
    return this.socialLogin(
      'googleSub',
      identity,
      dto.ageConfirmed,
      identity.name,
      userAgent,
    );
  }

  /**
   * Les comptes Apple/Google sont identifiés uniquement par l'identifiant du fournisseur.
   * On ne les fusionne jamais avec un compte email (les emails ne sont pas vérifiés :
   * une fusion permettrait de prendre le contrôle d'un compte).
   */
  private async socialLogin(
    field: 'appleSub' | 'googleSub',
    identity: SocialIdentity,
    ageConfirmed: boolean | undefined,
    name: string | undefined,
    userAgent?: string,
  ) {
    const where =
      field === 'appleSub'
        ? { appleSub: identity.sub }
        : { googleSub: identity.sub };
    const existing = await this.prisma.user.findUnique({
      where,
      select: { id: true, tokenVersion: true, status: true },
    });
    if (existing) {
      if (existing.status === 'BANNED')
        throw new ForbiddenException({
          code: 'ACCOUNT_BANNED',
          message: 'Compte suspendu',
        });
      return { ...(await this.session(existing, userAgent)), isNewUser: false };
    }

    // Nouveau compte : l'app doit d'abord afficher la question sur l'âge.
    if (ageConfirmed !== true) throw ageRequired();

    const displayName = (name ?? '').trim().slice(0, 50) || 'Orateur';
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = this.suggestUsername(
        name ?? identity.email?.split('@')[0] ?? 'orateur',
      );
      try {
        const user = await this.prisma.user.create({
          data: {
            ...where,
            username,
            displayName,
            socialEmail: identity.email,
            ageConfirmedAt: new Date(),
          },
          select: { id: true, tokenVersion: true },
        });
        return { ...(await this.session(user, userAgent)), isNewUser: true };
      } catch (e) {
        if (!(
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ))
          throw e;
        // Collision de pseudo (ou double clic) : on réessaie, ou on renvoie le compte créé entre-temps.
        const raced = await this.prisma.user.findUnique({
          where,
          select: { id: true, tokenVersion: true },
        });
        if (raced)
          return {
            ...(await this.session(raced, userAgent)),
            isNewUser: false,
          };
      }
    }
    throw new ConflictException('Impossible de créer le compte, réessaie');
  }

  /** Pseudo de départ (modifiable ensuite) : prénom simplifié + 4 chiffres. */
  private suggestUsername(seed: string) {
    const base =
      seed
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 20) || 'orateur';
    const safe =
      RESERVED_USERNAMES.has(base) || base.length < 3 ? 'orateur' : base;
    return `${safe}${randomInt(1000, 10000)}`;
  }

  refresh(refreshToken: string, userAgent?: string) {
    return this.tokens.rotate(refreshToken, userAgent);
  }

  async logout(userId: string, refreshToken?: string, pushToken?: string) {
    if (refreshToken) await this.tokens.revoke(refreshToken, userId);
    if (pushToken)
      await this.prisma.pushToken.deleteMany({
        where: { token: pushToken, userId },
      });
    return { ok: true };
  }

  async logoutAll(userId: string) {
    await this.tokens.revokeAll(userId);
    JwtAuthGuard.invalidate(userId);
    return { ok: true };
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    userAgent?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash) {
      throw new ForbiddenException({
        code: 'NO_PASSWORD',
        message: 'Ce compte se connecte avec Apple ou Google',
      });
    }
    if (
      !(await argon2
        .verify(user.passwordHash, dto.currentPassword)
        .catch(() => false))
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Mot de passe actuel incorrect',
      });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(dto.newPassword, HASH_OPTIONS) },
    });
    // Toutes les autres sessions sont fermées ; celle-ci reçoit de nouveaux jetons.
    await this.tokens.revokeAll(userId);
    JwtAuthGuard.invalidate(userId);
    const fresh = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, tokenVersion: true },
    });
    return this.tokens.issue(fresh, userAgent);
  }
}
