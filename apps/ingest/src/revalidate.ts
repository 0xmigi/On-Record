import { logger } from "@onrecord/core";

// Dossiers on the web are cached (apps/web/app/p/[id]/page.tsx). When the
// record of a program changes here, tell the web to rebuild that one page so it
// is current now rather than at the end of its cache window.
//
// Batched: a sweep can change hundreds of programs in a burst, and one request
// per program would be hundreds of function invocations for one page each.
// Fire-and-forget: a missed refresh costs at most one cache window of
// staleness, so it must never fail or slow the work that triggered it.
//
// Off unless both are set, so backfills and local runs never call production.
const WEB_URL = process.env.WEB_URL ?? "";
const SECRET = process.env.REVALIDATE_SECRET ?? "";
const FLUSH_MS = 2_000;
const BATCH = 100;

const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export function refreshDossier(programId: string): void {
  if (!WEB_URL || !SECRET || !programId || programId === "unknown") return;
  pending.add(programId);
  timer ??= setTimeout(() => void flush(), FLUSH_MS);
}

async function flush(): Promise<void> {
  timer = null;
  const ids = [...pending];
  pending.clear();
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WEB_URL}/api/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-revalidate-secret": SECRET },
        body: JSON.stringify({ ids: batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.warn({ status: res.status, n: batch.length }, "dossier refresh refused");
    } catch (err) {
      logger.warn({ err: String(err), n: batch.length }, "dossier refresh failed");
    }
  }
}
