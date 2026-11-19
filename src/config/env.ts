/**
 * Variables d'environnement validées au démarrage : l'API refuse de démarrer si une valeur
 * obligatoire manque ou est trop faible (ex. secret JWT trop court).
 */
export interface Env {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  DATABASE_URL: string;
  JWT_ACCESS_SECRET: string;

  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_TRANSCRIBE_MODEL: string;

  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_BASE_URL: string;

  /** Bundle IDs iOS acceptés comme audience des jetons Apple. */
  APPLE_BUNDLE_IDS: string[];
  /** Client IDs Google (web, iOS, Android) acceptés comme audience. */
  GOOGLE_CLIENT_IDS: string[];

  REVENUECAT_WEBHOOK_AUTH: string;
  REVENUECAT_SECRET_KEY: string;
  REVENUECAT_ENTITLEMENT: string;

  EXPO_ACCESS_TOKEN: string;
  /** Notifications du site (Web Push). Vides = désactivées. Clés générées par `npm run vapid`. */
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** Contact transmis aux services push (mailto: ou https:). */
  VAPID_SUBJECT: string;
  MEDIA_CONCURRENCY: number;
  /** Origines web autorisées (version web de l'app). Vide = aucune. */
  CORS_ORIGINS: string[];
  /**
   * Clé partagée avec le serveur du site web (vhoa-web), qui appelle l'API pour ses visiteurs.
   * Avec elle, l'API accepte l'IP réelle du visiteur transmise par le site (limitation de débit).
   * Vide = fonction désactivée.
   */
  BFF_SECRET: string;

  /** Clé secrète Stripe (abonnement Premium vendu sur le site). Vide = vente désactivée. */
  STRIPE_SECRET_KEY: string;
  /** Secret de signature du webhook Stripe (whsec_…). */
  STRIPE_WEBHOOK_SECRET: string;
  /** Configuration du portail client Stripe propre à VHOA (bpc_…). Vide = portail désactivé. */
  STRIPE_PORTAL_CONFIG: string;
  /** Adresse publique du site (retours de paiement). */
  WEB_URL: string;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = [];
  const required = (key: string) => {
    const value = source[key]?.trim();
    if (!value) errors.push(`${key} manquant`);
    return value ?? '';
  };

  const nodeEnv = (source.NODE_ENV ?? 'development') as Env['NODE_ENV'];
  const jwtSecret = required('JWT_ACCESS_SECRET');
  if (jwtSecret && jwtSecret.length < 32)
    errors.push('JWT_ACCESS_SECRET doit faire au moins 32 caractères');

  const env: Env = {
    NODE_ENV: nodeEnv,
    PORT: Number(source.PORT ?? 3000),
    DATABASE_URL: required('DATABASE_URL'),
    JWT_ACCESS_SECRET: jwtSecret,
    OPENAI_API_KEY: required('OPENAI_API_KEY'),
    OPENAI_MODEL: source.OPENAI_MODEL?.trim() || 'gpt-5.4-mini',
    OPENAI_TRANSCRIBE_MODEL:
      source.OPENAI_TRANSCRIBE_MODEL?.trim() || 'whisper-1',
    R2_ACCOUNT_ID: required('R2_ACCOUNT_ID'),
    R2_ACCESS_KEY_ID: required('R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: required('R2_SECRET_ACCESS_KEY'),
    R2_BUCKET_NAME: required('R2_BUCKET_NAME'),
    R2_PUBLIC_BASE_URL: required('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
    APPLE_BUNDLE_IDS: list(source.APPLE_BUNDLE_IDS),
    GOOGLE_CLIENT_IDS: list(source.GOOGLE_CLIENT_IDS),
    REVENUECAT_WEBHOOK_AUTH: source.REVENUECAT_WEBHOOK_AUTH?.trim() ?? '',
    REVENUECAT_SECRET_KEY: source.REVENUECAT_SECRET_KEY?.trim() ?? '',
    REVENUECAT_ENTITLEMENT: source.REVENUECAT_ENTITLEMENT?.trim() || 'premium',
    EXPO_ACCESS_TOKEN: source.EXPO_ACCESS_TOKEN?.trim() ?? '',
    VAPID_PUBLIC_KEY: source.VAPID_PUBLIC_KEY?.trim() ?? '',
    VAPID_PRIVATE_KEY: source.VAPID_PRIVATE_KEY?.trim() ?? '',
    VAPID_SUBJECT: source.VAPID_SUBJECT?.trim() || 'https://vhoa.fr',
    MEDIA_CONCURRENCY: Math.max(1, Number(source.MEDIA_CONCURRENCY ?? 1)),
    CORS_ORIGINS: list(source.CORS_ORIGINS),
    BFF_SECRET: source.BFF_SECRET?.trim() ?? '',
    STRIPE_SECRET_KEY: source.STRIPE_SECRET_KEY?.trim() ?? '',
    STRIPE_WEBHOOK_SECRET: source.STRIPE_WEBHOOK_SECRET?.trim() ?? '',
    STRIPE_PORTAL_CONFIG: source.STRIPE_PORTAL_CONFIG?.trim() ?? '',
    WEB_URL: (source.WEB_URL?.trim() || 'http://localhost:3003').replace(
      /\/+$/,
      '',
    ),
  };

  if (env.BFF_SECRET && env.BFF_SECRET.length < 32) {
    errors.push('BFF_SECRET doit faire au moins 32 caractères');
  }

  if (nodeEnv === 'production') {
    if (
      !env.REVENUECAT_WEBHOOK_AUTH ||
      env.REVENUECAT_WEBHOOK_AUTH.length < 24
    ) {
      errors.push(
        'REVENUECAT_WEBHOOK_AUTH (24 caractères min.) est obligatoire en production',
      );
    }
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET)
      errors.push(
        'STRIPE_WEBHOOK_SECRET est obligatoire avec STRIPE_SECRET_KEY',
      );
    if (env.STRIPE_SECRET_KEY && !env.WEB_URL.startsWith('https://'))
      errors.push('WEB_URL doit être en https');
    if (Boolean(env.VAPID_PUBLIC_KEY) !== Boolean(env.VAPID_PRIVATE_KEY))
      errors.push('VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY vont ensemble');
    if (!env.R2_PUBLIC_BASE_URL.startsWith('https://'))
      errors.push('R2_PUBLIC_BASE_URL doit être en https');
  }

  if (errors.length) {
    throw new Error(`Configuration invalide :\n - ${errors.join('\n - ')}`);
  }
  return env;
}

/** Instance unique, chargée une fois au démarrage. */
let cached: Env | undefined;
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
