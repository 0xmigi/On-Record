import {
  accountExists,
  findJargon,
  LIMITS,
  transactionExists,
  type Network,
  type StoryDraft,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Verify stage (spec §4.6) — the structural guarantee behind the fact register.
// Programmatic fact-check before anything publishes:
//   * every receipt must resolve (tx exists / account exists / repo URL is live)
//   * numeric claims in the body must match event data within tolerance
//   * no banned jargon, no raw addresses, lengths enforced
// Fail → one rewrite attempt with the errors fed back → fail again → dead-letter.
// ---------------------------------------------------------------------------

export interface VerifyContext {
  network: Network;
  /** receipts offered to the writer; a story may not cite anything else */
  allowedReceipts: { kind: string; ref: string }[];
  /** ground-truth numbers a body claim may reference (e.g. tvl, copy count) */
  knownNumbers: number[];
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

export async function verifyStory(draft: StoryDraft, ctx: VerifyContext): Promise<VerifyResult> {
  const errors: string[] = [];

  // -- lengths ---------------------------------------------------------------
  if (draft.headline.length > LIMITS.headline) {
    errors.push(`headline is ${draft.headline.length} chars (max ${LIMITS.headline})`);
  }
  if (draft.body.length > LIMITS.body) {
    errors.push(`body is ${draft.body.length} chars (max ${LIMITS.body})`);
  }
  if (draft.inference && draft.inference.text.length > LIMITS.inference) {
    errors.push(`inference is ${draft.inference.text.length} chars (max ${LIMITS.inference})`);
  }

  // -- vocabulary ------------------------------------------------------------
  for (const [field, text] of [
    ["headline", draft.headline],
    ["body", draft.body],
    ["inference", draft.inference?.text ?? ""],
  ] as const) {
    const jargon = findJargon(text);
    if (jargon.length) errors.push(`${field} contains banned terms: ${jargon.join(", ")}`);
  }

  // -- receipts cited must come from the candidate list ----------------------
  const allowed = new Set(ctx.allowedReceipts.map((r) => `${r.kind}:${r.ref}`));
  for (const fact of draft.facts) {
    if (!allowed.has(`${fact.receipt.kind}:${fact.receipt.ref}`)) {
      errors.push(`fact cites a receipt that was not offered: ${fact.receipt.kind} ${fact.receipt.ref}`);
    }
  }

  // -- receipts must resolve on chain / on the web ---------------------------
  for (const fact of draft.facts) {
    const { kind, ref } = fact.receipt;
    try {
      if (kind === "tx" && !(await transactionExists(ctx.network, ref))) {
        errors.push(`tx receipt does not resolve: ${ref}`);
      } else if (kind === "account" && !(await accountExists(ctx.network, ref))) {
        errors.push(`account receipt does not resolve: ${ref}`);
      } else if (kind === "repo" && !(await urlResolves(ref))) {
        errors.push(`repo receipt does not resolve: ${ref}`);
      }
    } catch (err) {
      errors.push(`receipt check failed for ${kind} ${ref}: ${String(err)}`);
    }
  }

  // -- numeric claims within tolerance ----------------------------------------
  for (const claimed of extractNumbers(draft.body)) {
    const matched = ctx.knownNumbers.some(
      (known) => known > 0 && Math.abs(claimed - known) / known <= 0.25,
    );
    // integers ≤ 1000 are usually counts (copies, days) — same rule applies,
    // but zero known numbers means any number is unsupported
    if (!matched) errors.push(`body claims a number (${claimed}) not supported by event data`);
  }

  return { ok: errors.length === 0, errors };
}

async function urlResolves(url: string): Promise<boolean> {
  try {
    if (!/^https?:\/\//.test(url)) return false;
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Pull numeric claims out of story text: "$12M", "$1.4B", "34 copies", "3 weeks". */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const money = /\$\s?([\d,.]+)\s*([kmbt])?/gi;
  let m: RegExpExecArray | null;
  while ((m = money.exec(text))) {
    const base = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]?.toLowerCase() ?? ""] ?? 1;
    out.push(base * mult);
  }
  const counts = /\b(\d{1,6})\s+(cop(?:y|ies)|apps?|projects?|updates?|launches?|days?|weeks?|hours?)\b/gi;
  while ((m = counts.exec(text))) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    // durations get converted to days so "3 weeks" checks against day-counts
    if (unit.startsWith("week")) out.push(n * 7);
    else if (unit.startsWith("hour")) out.push(n / 24);
    else out.push(n);
  }
  return out;
}
