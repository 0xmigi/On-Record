// Guard against the trap that silently ate two production runs.
//
// packages/core/db/client.ts falls back to a localhost DSN when DATABASE_URL
// is unset, which is right for the long-running services — but lethal for a
// one-shot maintenance script. Run one without sourcing .env and it connects
// to your laptop, reports "written: 190", and looks like it worked. Production
// never changed.
//
// So these scripts demand an explicit DATABASE_URL and print where they are
// pointed before touching anything. No default, no guessing.

/** Resolve and echo the target DSN, or exit with instructions. Returns a
 *  "host:port/db" label safe to log — never the credentials. */
export function requireDatabaseTarget(script: string): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    process.stderr.write(
      `\n${script}: DATABASE_URL is not set.\n\n` +
        `  Refusing to run rather than silently defaulting to localhost — that\n` +
        `  is what made two earlier "successful" production runs no-ops.\n\n` +
        `  local:      set -a && . .env && set +a && ./node_modules/.bin/tsx src/${script}\n` +
        `  production: DATABASE_URL="$(railway variables --service Postgres --kv \\\n` +
        `                | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \\\n` +
        `                ./node_modules/.bin/tsx src/${script}\n\n`,
    );
    process.exit(1);
  }
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    process.stderr.write(`\n${script}: DATABASE_URL is not a parseable URL.\n\n`);
    process.exit(1);
  }
}
