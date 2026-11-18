import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Injectable,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';

import { type AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { JwtAuthGuard } from '../common/guards';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RevenueCatEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  entitlement_ids?: string[] | null;
  expiration_at_ms?: number | null;
  transferred_from?: string[];
  transferred_to?: string[];
}

/**
 * Abonnements gérés par RevenueCat. L'app identifie l'acheteur avec `Purchases.logIn(userId)`,
 * donc `app_user_id` = id VHOA. Le serveur ne croit jamais l'app sur parole : il se base sur
 * les webhooks signés et sur l'API RevenueCat.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressService,
  ) {}

  /** Lit l'état réel de l'abonnement auprès de RevenueCat (source de vérité). */
  async fetchPremiumUntil(userId: string): Promise<Date | null | undefined> {
    const key = env().REVENUECAT_SECRET_KEY;
    if (!key) return undefined;
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`RevenueCat ${res.status}`);
    const json = (await res.json()) as {
      subscriber?: {
        entitlements?: Record<string, { expires_date?: string | null }>;
      };
    };
    const ent = json.subscriber?.entitlements?.[env().REVENUECAT_ENTITLEMENT];
    if (!ent) return null;
    // Pas de date d'expiration = achat à vie.
    return ent.expires_date
      ? new Date(ent.expires_date)
      : new Date('2999-01-01T00:00:00Z');
  }

  async setPremium(userId: string, until: Date | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premiumUntil: true },
    });
    if (!user) return;
    const wasPremium = !!user.premiumUntil && user.premiumUntil > new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: { premiumUntil: until },
    });
    JwtAuthGuard.invalidate(userId);
    // Premier passage Premium : le gel du mois est accordé tout de suite.
    if (!wasPremium && until && until > new Date())
      await this.progress.grantMonthlyFreezes();
  }

  async sync(userId: string) {
    const until = await this.fetchPremiumUntil(userId);
    if (until === undefined)
      throw new ServiceUnavailableException('Synchronisation indisponible');
    await this.setPremium(userId, until);
    return {
      isPremium: !!until && until > new Date(),
      premiumUntil: until?.toISOString() ?? null,
    };
  }

  async handleWebhook(event: RevenueCatEvent) {
    if (!event.id || !event.type) return;
    // Idempotence : RevenueCat peut renvoyer le même événement plusieurs fois.
    const { count } = await this.prisma.billingEvent.createMany({
      data: [{ id: event.id.slice(0, 100), type: event.type.slice(0, 40) }],
      skipDuplicates: true,
    });
    if (!count) return;

    const candidates = [
      event.app_user_id,
      event.original_app_user_id,
      ...(event.aliases ?? []),
      ...(event.transferred_from ?? []),
      ...(event.transferred_to ?? []),
    ].filter((id): id is string => !!id && UUID_RE.test(id));
    const userIds = [...new Set(candidates)];
    if (!userIds.length) return;

    for (const userId of userIds) {
      let until: Date | null | undefined;
      try {
        until = await this.fetchPremiumUntil(userId);
      } catch (e) {
        this.logger.warn(
          `Lecture RevenueCat impossible (${(e as Error).message}), on utilise l'événement`,
        );
      }
      if (until === undefined) until = this.untilFromEvent(event);
      if (until !== undefined) await this.setPremium(userId, until);
    }
    await this.prisma.billingEvent.updateMany({
      where: { id: event.id },
      data: { userId: userIds[0] },
    });
  }

  /** Repli si la clé secrète RevenueCat n'est pas configurée. */
  private untilFromEvent(e: RevenueCatEvent): Date | null | undefined {
    const hasEntitlement = (e.entitlement_ids ?? []).includes(
      env().REVENUECAT_ENTITLEMENT,
    );
    switch (e.type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'PRODUCT_CHANGE':
      case 'NON_RENEWING_PURCHASE':
      case 'SUBSCRIPTION_EXTENDED':
        if (!hasEntitlement) return undefined;
        return e.expiration_at_ms
          ? new Date(e.expiration_at_ms)
          : new Date('2999-01-01T00:00:00Z');
      case 'EXPIRATION':
        return null;
      default:
        // CANCELLATION, BILLING_ISSUE… : l'accès reste valable jusqu'à l'expiration.
        return undefined;
    }
  }
}

@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Webhook RevenueCat : l'en-tête Authorization doit correspondre au secret configuré. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/revenuecat')
  @HttpCode(200)
  async webhook(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { event?: RevenueCatEvent },
  ) {
    const secret = env().REVENUECAT_WEBHOOK_AUTH;
    if (!secret) throw new ServiceUnavailableException();
    const given = Buffer.from(auth ?? '');
    const accepted = [Buffer.from(secret), Buffer.from(`Bearer ${secret}`)];
    if (
      !accepted.some(
        (a) => a.length === given.length && timingSafeEqual(a, given),
      )
    ) {
      throw new UnauthorizedException();
    }
    if (body?.event) await this.billing.handleWebhook(body.event);
    return { ok: true };
  }

  /** Appelé par l'app juste après un achat ou une restauration. */
  @Post('me/subscription/sync')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  sync(@CurrentUser() user: AuthUser) {
    return this.billing.sync(user.id);
  }
}
