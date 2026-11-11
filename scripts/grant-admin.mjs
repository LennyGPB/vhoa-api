// Donne le rôle admin à un compte : npm run admin:grant -- <pseudo>
import pg from 'pg';

try {
  process.loadEnvFile();
} catch {
  /* variables déjà définies */
}
const username = process.argv[2]?.toLowerCase();
if (!username) {
  console.error('Usage : npm run admin:grant -- <pseudo>');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const res = await client.query(
  `UPDATE "User" SET "role" = 'ADMIN', "tokenVersion" = "tokenVersion" + 1 WHERE "username" = $1 RETURNING "id"`,
  [username],
);
console.log(res.rowCount ? `✅ ${username} est maintenant admin (reconnexion nécessaire).` : `❌ Pseudo introuvable : ${username}`);
await client.end();
