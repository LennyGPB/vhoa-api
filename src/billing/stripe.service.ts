import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Stripe from 'stripe';

import type { AuthUser } from '../common/auth.decorators';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.controller';

export type Plan = 'monthly' | 'yearly';

/**
 * Repères des objets Stripe propres à VHOA (créés par `npm run stripe:setup`).
 * Le compte Stripe peut être partagé avec d'autres activités : tout ce qui concerne VHOA
 * porte `metadata.app = "vhoa"`, et le reste est ignoré.
 */
export const STRIPE_LOOKUP: Record<Plan, string> = {
  monthly: 'vhoa_premium_monthly',
  yearly: 'vhoa_premium_yearly',
};
/** Offre de lancement : 1re année à 25 € au lieu de 35 €, pour les 100 premiers abonnés annuels. */
export const LAUNCH_COUPON = 'VHOA_LANCEMENT';

/** Statuts qui donnent accès à Premium (past_due : Stripe retente le paiement). */
const ACTIVE = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
]);

const isVhoa = (s: Stripe.Subscription) => s.metadata?.app === 'vhoa';
const periodEnd = (s: Stripe.Subscription) =>
  Math.max(0, ...s.items.data.map((i) => i.current_period_end ?? 0));

export interface Offer {
  enabled: boolean;
  monthly: number | null;
  yearly: number | null;
  launch: { price: number; total: number; remaining: number } | null;
}

/** Abonnement Premium vendu sur le site (Stripe Checkout + webhooks). */
@Injectable()
export class StripeBillingService {
  private readonly logger = new Logger('Stripe');
  private client?: Stripe;
  private priceCache?: { at: number; ids: Partial<Record<Plan, Stripe.Price>> };
  private offerCache?: { at: number; offer: Offer };

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  get enabled() {
    return !!env().STRIPE_SECRET_KEY;
  }

  private stripe() {
    if (!this.enabled)
      throw new ServiceUnavailableException({
        code: 'PAYMENT_UNAVAILABLE',
        message: 'Le paiement n’est pas encore ouvert',
      });
    this.client ??= new Stripe(env().STRIPE_SECRET_KEY, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      appInfo: { name: 'VHOA' },
    });
    return this.client;
  }

  /** Erreur Stripe → message propre (le détail reste dans les journaux). */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof Stripe.errors.StripeError)) throw e;
      this.logger.error(`${what} : ${e.type} ${e.code ?? ''} ${e.message}`);
      throw new BadGatewayException({
        code: 'PAYMENT_UNAVAILABLE',
        message:
          'Le paiement est momentanément indisponible, réessaie plus tard',
      });
    }
  }

  /** Prix actifs, retrouvés par leur `lookup_key` (gardés 10 minutes). */
  private async prices() {
    if (this.priceCache && Date.now() - this.priceCache.at < 600_000)
      return this.priceCache.ids;
    const list = await this.call('Lecture des prix', () =>
      this.stripe().prices.list({
        lookup_keys: Object.values(STRIPE_LOOKUP),
        active: true,
        limit: 10,
      }),
    );
    const ids: Partial<Record<Plan, Stripe.Price>> = {};
    for (const plan of Object.keys(STRIPE_LOOKUP) as Plan[]) {
      const p = list.data.find((x) => x.lookup_key === STRIPE_LOOKUP[plan]);
      if (p) ids[plan] = p;
    }
    this.priceCache = { at: Date.now(), ids };
    return ids;
  }

  private async launchCoupon() {
    try {
      const c = await this.stripe().coupons.retrieve(LAUNCH_COUPON);
      if (!c.valid || !c.max_redemptions) return null;
      const remaining = Math.max(0, c.max_redemptions - c.times_redeemed);
      return remaining > 0 ? { coupon: c, remaining } : null;
    } catch (e) {
      if (e instanceof Stripe.errors.StripeError && e.statusCode === 404)
        return null;
      throw e;
    }
  }

  /** Tarifs affichés sur la page Premium (avec le nombre réel de places de lancement). */
  async offer(): Promise<Offer> {
    if (!this.enabled)
      return { enabled: false, monthly: null, yearly: null, launch: null };
    if (this.offerCache && Date.now() - this.offerCache.at < 60_000)
      return this.offerCache.offer;
    const prices = await this.prices();
    const launch = await this.call('Offre de lancement', () =>
      this.launchCoupon(),
    );
    const yearly = prices.yearly?.unit_amount ?? null;
    const offer: Offer = {
      enabled: !!prices.monthly && !!prices.yearly,
      monthly: prices.monthly?.unit_amount ?? null,
      yearly,
      launch:
        launch && yearly !== null && launch.coupon.amount_off
          ? {
              price: yearly - launch.coupon.amount_off,
              total: launch.coupon.max_redemptions ?? 0,
              remaining: launch.remaining,
            }
          : null,
    };
    this.offerCache = { at: Date.now(), offer };
    return offer;
  }

  /** Client Stripe du compte, créé au premier achat. */
  private async customerId(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        stripeCustomerId: true,
        email: true,
        socialEmail: true,
        displayName: true,
      },
    });
    if (!u) throw new NotFoundException('Compte introuvable');
    if (u.stripeCustomerId) return u.stripeCustomerId;
    const customer = await this.call('Création du client', () =>
      this.stripe().customers.create(
        {
          email: u.email ?? u.socialEmail ?? undefined,
          name: u.displayName,
          preferred_locales: ['fr'],
          metadata: { app: 'vhoa', userId },
        },
        { idempotencyKey: `vhoa-customer-${userId}` },
      ),
    );
    // Deux demandes simultanées : la première enregistrée gagne (même client grâce à la clé).
    await this.prisma.user.updateMany({
      where: { id: userId, stripeCustomerId: null },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  private async subscriptions(customerId: string) {
    const list = await this.call('Lecture des abonnements', () =>
      this.stripe().subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
      }),
    );
    return list.data.filter(isVhoa);
  }

  /** L'abonnement en cours (ou le dernier) du compte. */
  private async current(customerId: string) {
    const subs = await this.subscriptions(customerId);
    return (
      subs.find((s) => ACTIVE.has(s.status)) ??
      subs.find((s) => s.status === 'incomplete') ??
      null
    );
  }

  /** Recalcule `premiumUntil` à partir de Stripe (source de vérité). */
  async syncUser(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    if (!u?.stripeCustomerId) return null;
    const subs = await this.subscriptions(u.stripeCustomerId);
    const end = Math.max(
      0,
      ...subs.filter((s) => ACTIVE.has(s.status)).map(periodEnd),
    );
    const until = end ? new Date(end * 1000) : null;
    await this.billing.setPremium(userId, until);
    return until;
  }

  async checkout(user: AuthUser, plan: Plan) {
    if (user.isPremium)
      throw new ConflictException({
        code: 'ALREADY_PREMIUM',
        message: 'Tu es déjà Premium',
      });
    const prices = await this.prices();
    const price = prices[plan];
    if (!price)
      throw new ServiceUnavailableException({
        code: 'PAYMENT_UNAVAILABLE',
        message: 'Le paiement n’est pas encore ouvert',
      });
    const customer = await this.customerId(user.id);
    // Un abonnement déjà actif (paiement fait mais pas encore synchronisé) : on ne double pas.
    if (await this.current(customer).then((s) => s && ACTIVE.has(s.status))) {
      await this.syncUser(user.id);
      throw new ConflictException({
        code: 'ALREADY_PREMIUM',
        message: 'Tu es déjà Premium',
      });
    }
    const launch =
      plan === 'yearly'
        ? await this.call('Offre de lancement', () => this.launchCoupon())
        : null;
    const web = env().WEB_URL;
    const session = await this.call('Création du paiement', () =>
      this.stripe().checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: user.id,
        line_items: [{ price: price.id, quantity: 1 }],
        ...(launch ? { discounts: [{ coupon: LAUNCH_COUPON }] } : {}),
        locale: 'fr',
        metadata: {
          app: 'vhoa',
          userId: user.id,
          plan,
        },
        subscription_data: { metadata: { app: 'vhoa', userId: user.id, plan } },
        success_url: `${web}/premium/merci?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${web}/premium`,
      }),
    );
    if (!session.url) throw new BadGatewayException('Paiement indisponible');
    return { url: session.url };
  }

  /** Retour de paiement : vérifie la session et active Premium sans attendre le webhook. */
  async confirm(user: AuthUser, sessionId?: string) {
    if (sessionId) {
      const s = await this.call('Lecture du paiement', () =>
        this.stripe().checkout.sessions.retrieve(sessionId),
      );
      if (s.client_reference_id !== user.id)
        throw new NotFoundException('Paiement introuvable');
    }
    const until = await this.syncUser(user.id);
    return {
      isPremium: !!until && until > new Date(),
      premiumUntil: until?.toISOString() ?? null,
    };
  }

  /** État de l'abonnement pour la page « Mon abonnement ». */
  async status(user: AuthUser) {
    const u = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true, premiumUntil: true },
    });
    const sub =
      this.enabled && u?.stripeCustomerId
        ? await this.current(u.stripeCustomerId)
        : null;
    if (!sub || !ACTIVE.has(sub.status)) {
      return {
        source: user.isPremium ? ('app' as const) : null,
        premiumUntil: user.isPremium
          ? (u?.premiumUntil?.toISOString() ?? null)
          : null,
        canManage: false,
      };
    }
    const item = sub.items.data[0];
    return {
      source: 'stripe' as const,
      plan: sub.metadata.plan === 'yearly' ? 'yearly' : 'monthly',
      status: sub.status,
      /** Montant des renouvellements (la remise de lancement ne vaut que pour la 1re année). */
      amount: item?.price.unit_amount ?? null,
      currentPeriodEnd: new Date(periodEnd(sub) * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end || !!sub.cancel_at,
      premiumUntil: new Date(periodEnd(sub) * 1000).toISOString(),
      canManage: !!env().STRIPE_PORTAL_CONFIG,
    };
  }

  /** Résiliation (effective à la fin de la période payée) ou reprise. */
  async setCancel(user: AuthUser, cancel: boolean) {
    const u = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true },
    });
    const sub = u?.stripeCustomerId
      ? await this.current(u.stripeCustomerId)
      : null;
    if (!sub || !ACTIVE.has(sub.status))
      throw new NotFoundException({
        code: 'NO_SUBSCRIPTION',
        message: 'Aucun abonnement en cours',
      });
    await this.call('Mise à jour de l’abonnement', () =>
      this.stripe().subscriptions.update(sub.id, {
        cancel_at_period_end: cancel,
      }),
    );
    return this.status(user);
  }

  /** Portail Stripe : moyen de paiement et factures. */
  async portal(user: AuthUser) {
    const config = env().STRIPE_PORTAL_CONFIG;
    const u = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { stripeCustomerId: true },
    });
    if (!config || !u?.stripeCustomerId)
      throw new NotFoundException({
        code: 'NO_SUBSCRIPTION',
        message: 'Aucun abonnement à gérer',
      });
    const session = await this.call('Portail client', () =>
      this.stripe().billingPortal.sessions.create({
        customer: u.stripeCustomerId!,
        configuration: config,
        locale: 'fr',
        return_url: `${env().WEB_URL}/profil/abonnement`,
      }),
    );
    return { url: session.url };
  }

  /**
   * Suppression du compte : l'abonnement est arrêté tout de suite (sinon il continuerait
   * d'être prélevé). Échoue si Stripe ne répond pas, pour ne jamais laisser un prélèvement orphelin.
   */
  async cancelAllForDeletion(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    if (!u?.stripeCustomerId || !this.enabled) return;
    const subs = await this.subscriptions(u.stripeCustomerId);
    for (const s of subs) {
      if (s.status === 'canceled' || s.status === 'incomplete_expired')
        continue;
      await this.call('Arrêt de l’abonnement', () =>
        this.stripe().subscriptions.cancel(s.id),
      );
    }
  }

  /* ---------- Webhook ---------- */

  async webhook(raw: Buffer | undefined, signature: string | undefined) {
    const secret = env().STRIPE_WEBHOOK_SECRET;
    if (!this.enabled || !secret) throw new ServiceUnavailableException();
    if (!raw || !signature)
      throw new BadRequestException('Signature manquante');
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(raw, signature, secret);
    } catch {
      throw new BadRequestException('Signature invalide');
    }

    const customer = customerOf(event);
    if (!customer) return;
    // Le compte Stripe peut servir à d'autres activités : seuls les clients VHOA comptent.
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: customer },
      select: { id: true },
    });
    if (!user) return;

    // Idempotence : Stripe peut renvoyer le même événement.
    const { count } = await this.prisma.billingEvent.createMany({
      data: [{ id: event.id, type: event.type.slice(0, 40), userId: user.id }],
      skipDuplicates: true,
    });
    if (!count) return;
    try {
      await this.syncUser(user.id);
    } catch (e) {
      // Stripe retentera : on retire la trace pour retraiter l'événement.
      await this.prisma.billingEvent.deleteMany({ where: { id: event.id } });
      throw e;
    }
  }

  /** Filet de sécurité si un webhook se perd : resynchronise les abonnés en fin de période. */
  async resyncExpiring() {
    if (!this.enabled) return;
    const now = Date.now();
    const users = await this.prisma.user.findMany({
      where: {
        stripeCustomerId: { not: null },
        premiumUntil: {
          gt: new Date(now - 3 * 86_400_000),
          lt: new Date(now + 2 * 3_600_000),
        },
      },
      select: { id: true },
      take: 200,
    });
    for (const u of users) {
      try {
        await this.syncUser(u.id);
      } catch (e) {
        this.logger.warn(`Resynchronisation ${u.id} : ${(e as Error).message}`);
      }
    }
  }
}

const idOf = (v: string | { id: string } | null | undefined) =>
  !v ? null : typeof v === 'string' ? v : v.id;

/** Client concerné par un événement (abonnement, facture ou paiement). */
function customerOf(event: Stripe.Event): string | null {
  const o = event.data.object as { object?: string; customer?: unknown };
  switch (o.object) {
    case 'checkout.session':
    case 'subscription':
    case 'invoice':
      return idOf(o.customer as string | { id: string } | null);
    default:
      return null;
  }
}
