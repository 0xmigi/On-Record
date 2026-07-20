// Formatting helpers. All data rendering (times, money, identifiers)
// goes through here so the record reads consistently everywhere.

/** "4m ago", "3h ago", "2d ago" — for timestamps in the past. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** "3d left", "6h left" — for deadlines in the future; "expired" once past. */
export function timeLeft(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.floor((then - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

/** "2026-07-06 14:32 UTC" — absolute time for the technical record. */
/** Internal capture ids, not real transaction signatures: the poller watches
 *  ProgramData *account state* and the backfill enumerates accounts, so neither
 *  can cite a transaction. Mirrors SYNTHETIC_SIG_PREFIXES in
 *  apps/ingest/src/timeline.ts (the web talks to the API over HTTP only, so it
 *  deliberately doesn't depend on @onrecord/core). */
const SYNTHETIC_SIG_PREFIXES = ["backfill:", "poll:", "incubation-backfill:"];

/** True when a "signature" is one of our capture ids rather than a real on-chain
 *  signature. Those must never be rendered as a verifiable receipt — linking one
 *  to an explorer produces a dead link, which is worse than showing nothing. */
export function isSyntheticSignature(signature: string | null | undefined): boolean {
  if (!signature) return false;
  return SYNTHETIC_SIG_PREFIXES.some((p) => signature.startsWith(p));
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "15 Feb 2023" — a full calendar day in UTC. Deterministic (no locale, no
 *  time-of-day) so it renders identically on server and client — anchors a
 *  program in time when clicking back through lineage links. */
export function dayStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** "$12.3M", "$940K", "$1.2B", "$87" — compact USD. */
export function compactUsd(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  const trim = (v: number): string => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/** "Gh4x…9kQp" — truncated identifier; short values pass through. */
export function truncateAddress(value: string): string {
  if (value.length <= 11) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** "12.4 KB", "980 B" — program image size for the facts row. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** "1,974", "612" — grouped integers for the funnel and counters. */
export function groupNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

/** 0.94 → "94" — novelty score rendered as an instrument gauge (0–100). */
export function noveltyGauge(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

/** "github.com/org/repo" — a URL stripped down to something readable. */
export function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`;
  } catch {
    return value;
  }
}
