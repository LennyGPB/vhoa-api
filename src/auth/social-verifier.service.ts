import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';

import { env } from '../config/env';

/** Clés publiques mises en cache par jose (rechargées automatiquement si Apple/Google les changent). */
const APPLE_KEYS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),
);
const GOOGLE_KEYS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);

export interface SocialIdentity {
  sub: string;
  email?: string;
  name?: string;
}

const invalid = () =>
  new UnauthorizedException({
    code: 'INVALID_SOCIAL_TOKEN',
    message: 'Connexion refusée, réessaie',
  });

/** Vérifie la signature, l'émetteur, l'audience et l'expiration des jetons Apple / Google. */
@Injectable()
export class SocialVerifierService {
  async apple(
    identityToken: string,
    rawNonce: string,
  ): Promise<SocialIdentity> {
    const audience = env().APPLE_BUNDLE_IDS;
    if (!audience.length)
      throw new ServiceUnavailableException('Connexion Apple non configurée');
    try {
      const { payload } = await jwtVerify(identityToken, APPLE_KEYS, {
        issuer: 'https://appleid.apple.com',
        audience,
        algorithms: ['RS256'],
        clockTolerance: 30,
      });
      // Le nonce empêche de rejouer un jeton intercepté.
      const expected = createHash('sha256').update(rawNonce).digest('hex');
      const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
      if (
        nonce.length !== expected.length ||
        !timingSafeEqual(Buffer.from(nonce), Buffer.from(expected))
      )
        throw invalid();
      if (!payload.sub) throw invalid();
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
      };
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw invalid();
    }
  }

  async google(idToken: string): Promise<SocialIdentity> {
    const audience = env().GOOGLE_CLIENT_IDS;
    if (!audience.length)
      throw new ServiceUnavailableException('Connexion Google non configurée');
    try {
      const { payload } = await jwtVerify(idToken, GOOGLE_KEYS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience,
        algorithms: ['RS256'],
        clockTolerance: 30,
      });
      if (!payload.sub) throw invalid();
      return {
        sub: payload.sub,
        email:
          payload.email_verified === true && typeof payload.email === 'string'
            ? payload.email
            : undefined,
        name:
          typeof payload.given_name === 'string'
            ? payload.given_name
            : typeof payload.name === 'string'
              ? payload.name
              : undefined,
      };
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw invalid();
    }
  }
}
