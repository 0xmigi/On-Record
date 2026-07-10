import type { ApiProgram } from "@/lib/api";

// ---------------------------------------------------------------------------
// Lifecycle / churn — the tail of the bot pattern. A program that gets deployed,
// spammed with failed txns, then closed (rent reclaimed) within minutes, over
// and over under fresh ids. `closedAt` is a detection time (we see the
// ProgramData is gone, not the close tx), so the lifespan is an upper bound —
// "closed within N of deploy", never a false-precise timestamp.
// ---------------------------------------------------------------------------

export interface Lifecycle {
  closed: boolean;
  lifespanLabel: string | null; // deploy → detected-closed, e.g. "12m", "3h"
  shortLived: boolean; // closed under 6h after deploy
  ephemeral: boolean; // clone + closed / short-lived — the churn signature
  redeploy: boolean; // band=clone — byte-identical to known code, a fresh id
  sniper: boolean; // a redeploy wired to Pump.fun — the sniper flavor
}

// ---------------------------------------------------------------------------
// Honest labelling of byte-clones. band=clone is a *fact* (identical bytecode
// already on record). What it *means* is graded by confidence — we only call
// something a bot when the on-chain signature backs it:
//   sniper     clone wired to Pump.fun — the launch-sniper signature (high)
//   throwaway  clone that was closed — deploy, run, close for the rent (high)
//   recycled   clone, nothing else — could be a factory/launchpad/template
//              deploying identical instances, or a dev redeploying. NO bot claim.
// ---------------------------------------------------------------------------
export type BotKind = "sniper" | "throwaway" | "recycled";

export function botKind(p: ApiProgram): BotKind | null {
  if (p.band !== "clone") return null;
  if ((p.integrations ?? []).includes("Pump.fun")) return "sniper";
  if (p.closed) return "throwaway";
  return "recycled";
}

export const BOT_LABEL: Record<BotKind, string> = {
  sniper: "pump.fun sniper",
  throwaway: "throwaway bot",
  recycled: "recycled",
};

function fmtSpan(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function deriveLifecycle(p: ApiProgram): Lifecycle {
  const deployed = p.firstDeployAt ?? p.deployedAt;
  let lifespanMs: number | null = null;
  if (p.closed && p.closedAt && deployed) {
    lifespanMs = Math.max(0, Date.parse(p.closedAt) - Date.parse(deployed));
  }
  const shortLived = lifespanMs != null && lifespanMs < 6 * 3_600_000;
  const redeploy = p.band === "clone";
  return {
    closed: p.closed,
    lifespanLabel: lifespanMs != null ? fmtSpan(lifespanMs) : null,
    shortLived,
    ephemeral: p.closed && (p.band === "clone" || shortLived),
    redeploy,
    sniper: redeploy && (p.integrations ?? []).includes("Pump.fun"),
  };
}
