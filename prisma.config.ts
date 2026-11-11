import { defineConfig } from 'prisma/config';

// Charge le .env en local (sur Railway, les variables sont déjà dans l'environnement).
try {
  process.loadEnvFile();
} catch {
  /* pas de .env : rien à faire */
}

/**
 * Les migrations passent par la connexion directe de Neon (sans « -pooler ») :
 * le pooler en mode transaction ne gère pas les verrous de migration.
 */
const pooled = process.env.DATABASE_URL ?? '';
const direct = process.env.DIRECT_DATABASE_URL ?? pooled.replace('-pooler.', '.');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: direct },
});
