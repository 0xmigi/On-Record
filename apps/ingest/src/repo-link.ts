import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema, logger, searchRepoByProgramId, env, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Repo-link sweep: find the source repo for programs that declared none, by
// searching public code for the program id (core/identity.ts).
//
// Deliberately NOT in the pipeline. Two reasons:
//
//  1. Most deploys are bot churn — redeploy, spam, close, repeat — and the
//     closed sweep only learns that minutes later. Searching at identify time
//     spends the budget on programs that no longer exist. Waiting an hour and
//     skipping anything already closed drops nearly all of it.
//  2. Code search allows ~10 requests/minute. The whole deploy stream cannot
//     fit through that; the novel band can, with room to spare.
//
// So: novel, still alive, no repo from any other source, at least an hour old.
// Misses are stamped too (repoLinkCheckedAt) — a program with no public source
// has none on the next pass either, and re-asking every hour would burn the
// budget on permanent negatives. The stamp expires, because a repo published
// next week is still worth finding.
// ---------------------------------------------------------------------------

const SWEEP_MAX = Number(process.env.REPO_LINK_SWEEP_MAX ?? 20);
/** Give the closed sweep time to mark bot churn before we spend a search. */
const MIN_AGE_HOURS = Number(process.env.REPO_LINK_MIN_AGE_HOURS ?? 1);
/** How far back to keep looking — a program's repo may appear after its deploy. */
const LOOKBACK_DAYS = Number(process.env.REPO_LINK_LOOKBACK_DAYS ?? 14);
/** Re-ask about a program with no repo this often, not every pass. */
const RECHECK_HOURS = Number(process.env.REPO_LINK_RECHECK_HOURS ?? 72);

export async function sweepRepoLinks(network: Network = "mainnet"): Promise<void> {
  if (!env.GITHUB_TOKEN) return; // unset = feature off, no noise

  const rows = await db
    .select({ id: schema.subjects.id, crate: schema.subjects.crate })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.network, network),
        // Everything but clones. `novel` alone was too tight: a program that
        // resembles something in the corpus is still somebody's real project —
        // Shyft, and both corsur programs, all land in `variant`, and those are
        // precisely the ones with a public repo. Clones are the factory output
        // this is pointless for.
        sql`${schema.subjects.noveltyBand} in ('novel', 'variant')`,
        // nobody declared one: no verified build, no security.txt, no URL in
        // the binary — upsertSubject collapses all three into repoUrl
        isNull(schema.subjects.repoUrl),
        // closed programs are the churn tail; their source was never public
        sql`${schema.subjects.facts}->>'closedAt' is null`,
        sql`${schema.subjects.facts}->>'repoLink' is null`,
        sql`(${schema.subjects.facts}->>'repoLinkCheckedAt' is null
             or (${schema.subjects.facts}->>'repoLinkCheckedAt')::timestamptz
                < now() - ${`${RECHECK_HOURS} hours`}::interval)`,
        sql`coalesce(${schema.subjects.firstSeenAt}, ${schema.subjects.updatedAt})
            < now() - ${`${MIN_AGE_HOURS} hours`}::interval`,
        sql`coalesce(${schema.subjects.firstSeenAt}, ${schema.subjects.updatedAt})
            > now() - ${`${LOOKBACK_DAYS} days`}::interval`,
      ),
    )
    // newest first: a fresh deploy is what the radar is showing right now
    .orderBy(sql`coalesce(${schema.subjects.firstSeenAt}, ${schema.subjects.updatedAt}) desc`)
    .limit(SWEEP_MAX);

  if (!rows.length) return;
  let linked = 0;

  for (const row of rows) {
    // subjects.crate is the workspace crate recovered from panic paths — the
    // same string the reverse lookup confirms against, so no bytecode refetch
    const link = await searchRepoByProgramId(row.id, { crateName: row.crate });
    const patch: Record<string, unknown> = { repoLinkCheckedAt: new Date().toISOString() };
    if (link) {
      patch.repoLink = link;
      linked++;
    }
    await db
      .update(schema.subjects)
      .set({
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.subjects.id, row.id), eq(schema.subjects.network, network)));
  }

  logger.info({ network, checked: rows.length, linked }, "repo-link sweep");
}
