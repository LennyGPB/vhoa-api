// Importé en tout premier par main.ts : le .env local doit être lu avant les autres modules.
try {
  process.loadEnvFile();
} catch {
  /* pas de .env (Railway fournit les variables directement) */
}
