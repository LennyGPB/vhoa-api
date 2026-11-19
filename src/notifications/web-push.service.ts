import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';

import { env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Navigateurs abonnés par compte : au-delà, les plus anciens sont retirés. */
const MAX_PER_USER = 10;

export interface WebPushPayload {
  title: string;
  body: string;
  /** Page ouverte au clic sur la notification (chemin du site). */
  url: string;
}

/**
 * Notifications du site (Web Push, norme des navigateurs) : chiffrées avec les clés VAPID
 * et remises par le service push du navigateur (Google, Mozilla, Apple…).
 * Sans clés VAPID configurées, tout est simplement désactivé.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger('WebPush');
  private readonly enabled: boolean;

  constructor(private readonly prisma: PrismaService) {
    const e = env();
    this.enabled = Boolean(e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY);
    if (this.enabled)
      webpush.setVapidDetails(
        e.VAPID_SUBJECT,
        e.VAPID_PUBLIC_KEY,
        e.VAPID_PRIVATE_KEY,
      );
  }

  /** Clé publique pour l'abonnement côté navigateur (null : notifications du site désactivées). */
  get publicKey() {
    return this.enabled ? env().VAPID_PUBLIC_KEY : null;
  }

  async subscribe(
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string },
  ) {
    // Un navigateur réutilisé par un autre compte passe au compte connecté.
    await this.prisma.webPushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, ...sub },
      update: { userId, p256dh: sub.p256dh, auth: sub.auth },
    });
    const extra = await this.prisma.webPushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: MAX_PER_USER,
      select: { id: true },
    });
    if (extra.length)
      await this.prisma.webPushSubscription.deleteMany({
        where: { id: { in: extra.map((s) => s.id) } },
      });
    return { ok: true };
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.webPushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return { ok: true };
  }

  /**
   * Envoie à tous les navigateurs abonnés des comptes donnés (préférences déjà filtrées par
   * `userWhere`). Ne lève jamais d'erreur : un échec sur un navigateur n'empêche pas les autres,
   * et la tâche n'est pas rejouée (pas de doublons).
   */
  async send(
    userIds: string[],
    userWhere: Prisma.UserWhereInput,
    payload: WebPushPayload,
  ) {
    if (!this.enabled || !userIds.length) return;
    const subs = await this.prisma.webPushSubscription.findMany({
      where: { userId: { in: userIds }, user: userWhere },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (!subs.length) return;

    const body = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 24 * 3600, timeout: 10_000, urgency: 'normal' },
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // Abonnement expiré ou retiré par l'utilisateur : on l'oublie.
          if (status === 404 || status === 410) dead.push(s.id);
          else
            this.logger.warn(
              `Envoi échoué (${status ?? '?'}) : ${(e as Error).message}`,
            );
        }
      }),
    );
    if (dead.length) {
      await this.prisma.webPushSubscription.deleteMany({
        where: { id: { in: dead } },
      });
      this.logger.log(`${dead.length} abonnement(s) web expiré(s) supprimé(s)`);
    }
  }
}
