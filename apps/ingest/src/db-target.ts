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

/** Same guard for the RPC key. A script that reads chain state needs this, and
 *  without it every call returns HTTP 401 — which a per-item catch reads as
 *  "this one program failed" and keeps going, so the run reports skips instead
 *  of the one real problem. Overriding DATABASE_URL for a production run while
 *  leaving .env unsourced is exactly how you end up here. */
export function requireRpcKey(script: string): void {
  if (process.env.HELIUS_API_KEY) return;
  process.stderr.write(
    `\n${script}: HELIUS_API_KEY is not set, but this script reads chain state.\n\n` +
      `  Every RPC call would 401 and be skipped, and the run would report\n` +
      `  success having done nothing.\n\n` +
      `  Source .env for the key, then override the database:\n\n` +
      `    set -a && . ../../.env && set +a\n` +
      `    DATABASE_URL="$(railway variables --service Postgres --kv \\\n` +
      `      | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \\\n` +
      `      ./node_modules/.bin/tsx src/${script}\n\n`,
  );
  process.exit(1);
}
