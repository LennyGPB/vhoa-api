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
  MEDIA_CONCURRENCY: number;
  /** Origines web autorisées (version web de l'app). Vide = aucune. */
  CORS_ORIGINS: string[];
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
    MEDIA_CONCURRENCY: Math.max(1, Number(source.MEDIA_CONCURRENCY ?? 1)),
    CORS_ORIGINS: list(source.CORS_ORIGINS),
  };

  if (nodeEnv === 'production') {
    if (
      !env.REVENUECAT_WEBHOOK_AUTH ||
      env.REVENUECAT_WEBHOOK_AUTH.length < 24
    ) {
      errors.push(
        'REVENUECAT_WEBHOOK_AUTH (24 caractères min.) est obligatoire en production',
      );
    }
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
