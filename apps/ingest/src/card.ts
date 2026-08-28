import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { and, eq } from "drizzle-orm";
import { db, schema, type Network } from "@onrecord/core";
import { edgesFor, type EdgeNode } from "./refs.js";
import { sampleComputeOnDemand, type ComputeSample } from "./compute.js";

// ---------------------------------------------------------------------------
// The share card — a program's hard facts, as one SVG.
//
// SAME DATA PATH AS EVERYTHING ELSE. `cardFacts` reads the stored rows the
// dossier and the reply already read: the subjects row, the reference graph
// (refs.ts), the sampled compute in facts. No RPC, no third-party fetch, no
// second pipeline. A stranger tagging the bot cannot make us spend a credit,
// which is the same reason composeReply is database-only.
//
// RENDERED WITHOUT A BROWSER. resvg is a Rust rasteriser with prebuilt Linux
// binaries, so this runs inside the Railway node container: ~110ms per card,
// fonts embedded from the repo, nothing written to disk. A headless-Chrome
// design could not have shipped here at all.
//
// Everything is absolutely positioned. There is no layout engine, so the card's
// geometry is arithmetic — which is also why its size cannot drift with the
// data. CARD_W and CARD_H are constants and the content is clipped to them: a
// program with eighty references renders the same size as one with none.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The faces live inside this app, not the web one. The container image only
 *  copies packages/ and apps/ingest/ — reaching into apps/web for a font
 *  compiled fine and then killed the process at boot, because the directory
 *  does not exist there. Both src/ and dist/ sit one level under apps/ingest. */
const FONT_DIR = path.resolve(HERE, "../assets/fonts");

/** Embedded, and system fonts are switched off at render time. A card that
 *  picks up whatever the host machine happens to have installed is not a record
 *  of anything — and the container has no fonts at all. */
const FONT_FILES = [
  path.join(FONT_DIR, "IBMPlexMono-Regular.ttf"),
  path.join(FONT_DIR, "IBMPlexMono-SemiBold.ttf"),
];
// fail at boot, not on the first mention, if the faces are not where we think
for (const f of FONT_FILES) readFileSync(f);

/** Orb's ring, the same path the site's mark uses. */
const ORB_RING =
  "M205.385 324.447L186.26 326.994L183.627 327.32C177.465 328.039 171.205 328.416 164.868 328.433C158.531 328.45 152.27 328.105 146.106 327.419L143.467 327.107L124.33 324.662L129.221 286.383L148.358 288.828L150.376 289.067C155.092 289.593 159.893 289.858 164.765 289.845C170.334 289.83 175.809 289.455 181.167 288.741L200.292 286.195L205.385 324.447ZM65.1269 241.036L66.3969 242.653C72.3844 250.146 79.2126 256.939 86.7374 262.886L88.3574 264.148L103.69 275.864L80.2584 306.523L64.9289 294.807L62.8079 293.16C52.9818 285.394 44.0687 276.524 36.2501 266.739L34.5888 264.63L22.7918 249.363L53.3299 225.769L65.1269 241.036ZM306.523 248.612L294.807 263.942C286.112 275.319 275.961 285.523 264.63 294.278L249.363 306.075L225.769 275.541L241.036 263.744C249.714 257.039 257.489 249.222 264.148 240.51L275.864 225.18L306.523 248.612ZM0.434085 164.868C0.414932 157.625 0.867742 150.481 1.7637 143.467L4.20902 124.33L42.4842 129.221L40.0388 148.358C39.3538 153.72 39.0075 159.197 39.0222 164.765C39.0369 170.334 39.4123 175.809 40.1257 181.167L42.6723 200.292L4.42357 205.385L1.87697 186.26L1.54737 183.627C0.828179 177.465 0.45086 171.205 0.434085 164.868ZM289.845 164.102C289.832 159.229 289.541 154.43 288.991 149.716L288.741 147.7L286.195 128.575L324.447 123.482L326.994 142.607L327.32 145.244C328.039 151.404 328.416 157.663 328.433 163.999C328.452 171.242 328.003 178.386 327.107 185.4L324.662 204.537L286.383 199.646L288.828 180.509L289.067 178.494C289.593 173.777 289.858 168.975 289.845 164.102ZM103.101 53.3299L87.8306 65.1269L86.2173 66.3969C78.189 72.812 70.9617 80.1895 64.7192 88.3574L53.0068 103.69L22.3442 80.2584L34.0602 64.9289L35.7103 62.8079C44.0315 52.2804 53.6175 42.7967 64.2401 34.5888L79.5074 22.7918L103.101 53.3299ZM263.942 34.0602L266.059 35.7103C275.885 43.477 284.802 52.343 292.62 62.1279L294.278 64.2401L306.075 79.5074L275.541 103.101L263.744 87.8306L262.474 86.2173C256.486 78.7241 249.658 71.932 242.133 65.9842L240.51 64.7192L225.18 53.0068L248.612 22.3442L263.942 34.0602ZM163.999 0.434085C170.337 0.417311 176.599 0.761489 182.764 1.44804L185.4 1.7637L204.537 4.20902L199.646 42.4842L180.509 40.0388C175.147 39.3538 169.671 39.0074 164.102 39.0222C158.533 39.0369 153.058 39.4123 147.7 40.1257L128.575 42.6723L123.482 4.42357L142.607 1.87697C149.615 0.943893 156.757 0.45327 163.999 0.434085Z";
/** The scalloped verified disc, from apps/web/components/VerifiedBadge.tsx. */
const VERIFIED_DISC =
  "M9.33 2.77Q12.05 -1.57 14.77 2.77Q19.41 0.59 19.36 5.72Q24.44 6.39 21.62 10.67Q25.53 13.99 20.84 16.07Q22.34 20.97 17.28 20.18Q15.89 25.12 12.05 21.72Q8.21 25.12 6.82 20.18Q1.75 20.97 3.25 16.07Q-1.43 13.99 2.48 10.67Q-0.34 6.39 4.74 5.72Q4.68 0.59 9.33 2.77Z";

// --- fixed geometry --------------------------------------------------------
const CANVAS_W = 1200, CANVAS_H = 700;
const CARD_X = 40, CARD_Y = 40, CARD_W = 1120, CARD_H = 620;
const PAD = 40;
const L = CARD_X + PAD;
const R = CARD_X + CARD_W - PAD;
const COL_R = CARD_X + 740;

const INK = "#1c1c1a", MUTED = "#8f8e88", FAINT = "#c3c3bd";
const PAPER = "#fcfcfa", BRAND = "#E8432C", GREEN = "#16874e";

const HOUR = 3_600_000;
const KB = 1024, MB = KB * KB;
/** what one transaction is allowed to burn */
const TX_CU_LIMIT = 1_400_000;

const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtSize = (n: number | null): string =>
  n === null ? "unknown" : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / KB)} KB`;
const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
/** "15 Mar 2023" — the format the dossier header uses */
const fullDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Plex Mono is monospaced at 0.6em, so text width is exact arithmetic — which
 *  is what makes absolute positioning viable without a layout engine. */
const textW = (s: string, size: number, tracking = 0): number =>
  s.length * (size * 0.6 + tracking);

interface TextOpts {
  size?: number;
  weight?: number;
  fill?: string;
  tracking?: number;
  anchor?: "start" | "middle" | "end";
}
const t = (x: number, y: number, s: string, o: TextOpts = {}): string =>
  `<text x="${x}" y="${y}" font-family="Plex" font-size="${o.size ?? 13}"` +
  ` font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}"` +
  (o.tracking ? ` letter-spacing="${o.tracking}"` : "") +
  (o.anchor ? ` text-anchor="${o.anchor}"` : "") +
  `>${esc(s)}</text>`;

export interface CardFacts {
  programId: string;
  network: Network;
  name: string | null;
  framework: string | null;
  sizeBytes: number | null;
  instructionCount: number | null;
  syscallCount: number | null;
  upgradeCount: number;
  /** the ProgramData walk hit its cap, so the count is a floor */
  upgradeTruncated: boolean;
  firstDeployAt: Date | null;
  authorityClass: string | null;
  multisig: { threshold?: number | null; members?: number | null } | null;
  verified: boolean;
  /** the deployer's own declared logo, when there is one */
  logoUrl: string | null;
  /** whatever the record knows to source a favicon from, in the site's order */
  iconSource: string | null;
  /** hourly transaction counts, up to 7 days (momentum.ts) */
  activity: { t: number; c: number }[] | null;
  /** the sampler hit its page cap, so the counts are a floor */
  truncated: boolean;
  compute: ComputeSample | null;
  references: { names: EdgeNode[]; namedBy: EdgeNode[] };
}

/**
 * Everything the card can letter, gathered from stored rows only.
 *
 * Same contract as composeReply: reads the database, never the chain.
 */
export async function cardFacts(programId: string): Promise<CardFacts | null> {
  const [row] = await db
    .select()
    .from(schema.subjects)
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.kind, "program")));
  if (!row) return null;

  const network = row.network as Network;
  const facts = (row.facts ?? {}) as Record<string, unknown>;
  const profile = row.profile as
    | { framework?: string; syscalls?: string[]; instructionCount?: number | null }
    | null;

  const momentum = facts.momentum as { txns24hTruncated?: boolean } | undefined;

  return {
    programId,
    network,
    name: sanitize(row.name),
    framework: profile?.framework && profile.framework !== "unknown" ? profile.framework : null,
    sizeBytes: row.sizeBytes,
    instructionCount: row.instructionCount ?? profile?.instructionCount ?? null,
    syscallCount: profile?.syscalls?.length ?? null,
    upgradeCount: Number(facts.upgradeCount ?? 0),
    upgradeTruncated: facts.upgradeCountTruncated === true,
    firstDeployAt: row.firstDeployAt ?? row.firstSeenAt ?? null,
    authorityClass: row.authorityClass,
    multisig: (facts.multisig as CardFacts["multisig"]) ?? null,
    verified: row.verified,
    logoUrl: (facts.logoUrl as string | undefined) ?? null,
    iconSource:
      (facts.website as string | undefined) ??
      (facts.social as string | undefined) ??
      row.repoUrl ??
      null,
    activity: (facts.activity as CardFacts["activity"]) ?? null,
    truncated: momentum?.txns24hTruncated === true,
    compute: (facts.compute as ComputeSample | undefined) ?? null,
    references: await edgesFor(network, programId),
  };
}

/**
 * The program's icon, as bytes.
 *
 * Same source order the site's ProgramAvatar uses: the declared logo, else a
 * favicon for whichever of website / social / repo we hold. This is the
 * record's own pattern, not a new data path — the radar row and the dossier
 * header resolve their icons exactly this way.
 *
 * The difference is that a browser can fetch lazily and fail invisibly, while
 * the card has to embed the bytes. So: a short timeout, a size ceiling, and a
 * null on any failure — the card then draws the two-character avatar instead,
 * which is what the site falls back to as well. A missing icon must never cost
 * us a reply.
 */
export async function fetchIcon(f: CardFacts): Promise<string | null> {
  const direct = f.logoUrl;
  let url = direct;
  if (!url && f.iconSource) {
    try {
      url = `https://www.google.com/s2/favicons?domain=${new URL(f.iconSource).hostname}&sz=128`;
    } catch {
      return null;
    }
  }
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    // resvg rasterises PNG and JPEG; an SVG favicon is not worth the risk here
    if (!/^image\/(png|jpeg)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 200_000) return null;
    return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Deployer-authored text, stripped of anything that could act. A program's
 *  declared name is a claim by the person with the most reason to manipulate
 *  what an automated account says about them. */
function sanitize(raw: string | null): string | null {
  if (!raw) return null;
  const clean = raw
    .replace(/[ -]+/g, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b[\w.-]+\.(com|xyz|io|net|org|fun|app|co|gg)\b/gi, "")
    .replace(/[@#$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > 34 ? `${clean.slice(0, 33)}…` : clean;
}

/** The authority, in the record's own vocabulary. */
function authority(cls: string | null, ms: CardFacts["multisig"]): string {
  if (cls === "none") return "immutable";
  if (cls === "program") return "a program";
  if (cls === "squads") return ms?.threshold && ms?.members ? `${ms.threshold} of ${ms.members}` : "multisig";
  if (cls === "hot_wallet") return "one wallet";
  return "unknown";
}

// --- compute per transaction ----------------------------------------------
// The bar is against the 1.4M a transaction may burn, so the empty part is
// headroom. NOTE this is the whole transaction's compute, not this program's
// share — a swap pays for every token program it routes through — which is why
// the label says "per transaction" and never "this program uses".
function computeBlock(cu: ComputeSample | null, y: number): { svg: string; next: number } {
  const W = COL_R - L - 60;
  const out = [t(L, y, "COMPUTE PER TRANSACTION", { size: 10, tracking: 2, weight: 600, fill: MUTED })];
  if (!cu) {
    out.push(t(L, y + 30, "not sampled yet", { size: 17, fill: FAINT }));
    return { svg: out.join(""), next: y + 30 };
  }

  // A single median lies about a bimodal program. Phoenix Eternal's median is
  // 894 while its p90 is 118,798 and its heaviest call is 884,264 — "894" makes
  // a perps engine look trivial. So the bar shows the whole spread: the band
  // from p10 to p90, the median inside it, and a tick where the heaviest call
  // landed. The scale is logarithmic because a linear axis against 1.4M puts
  // everything below 20k in the first pixel.
  const BY = y + 30, BH = 30;
  const LOG_MIN = 100;
  const pos = (v: number) => {
    const c = Math.min(Math.max(v, LOG_MIN), TX_CU_LIMIT);
    return (Math.log10(c / LOG_MIN) / Math.log10(TX_CU_LIMIT / LOG_MIN)) * W;
  };
  const lo = pos(cu.p10), hi = pos(cu.p90), mid = pos(cu.median), mx = pos(cu.max);
  const cheapPct = Math.round(cu.cheapShare * 100);

  out.push(
    `<g filter="url(#rough)">
      <rect x="${L}" y="${BY}" width="${W}" height="${BH}" rx="5" fill="none" stroke="${FAINT}" stroke-width="1.2"/>
      <rect x="${L + lo}" y="${BY}" width="${Math.max(2, hi - lo)}" height="${BH}" fill="${INK}" opacity="0.15"/>
      <path d="M ${L + mid} ${BY - 7} L ${L + mid} ${BY + BH + 7}" stroke="${PAPER}" stroke-width="5.4" fill="none" stroke-linecap="round"/>
      <path d="M ${L + mid} ${BY - 7} L ${L + mid} ${BY + BH + 7}" stroke="${BRAND}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
      <path d="M ${L + mx} ${BY + 4} L ${L + mx} ${BY + BH - 4}" stroke="${MUTED}" stroke-width="1.6" fill="none"/>
      ${
        cu.requestedMedian
          ? `<path d="M ${L + pos(cu.requestedMedian)} ${BY - 4} L ${L + pos(cu.requestedMedian)} ${BY + BH + 4}" stroke="${MUTED}" stroke-width="1.4" stroke-dasharray="3 3" fill="none"/>`
          : ""
      }
    </g>`,
    t(L, y + 22, `${compact(cu.median)} TYPICAL`, { size: 11, tracking: 1.6, weight: 600, fill: MUTED }),
    t(L + W, y + 22, "1.4M ALLOWED", { size: 11, tracking: 1.6, weight: 600, fill: MUTED, anchor: "end" }),
    // the sentence carries the shape; the bar carries the scale
    t(L, BY + BH + 30, `${compact(cu.p10)}–${compact(cu.p90)}`, { size: 19, weight: 600, tracking: 1.4 }),
    t(L + textW(`${compact(cu.p10)}–${compact(cu.p90)}`, 19, 1.4) + 12, BY + BH + 30,
      `for most calls, up to ${compact(cu.max)}`, { size: 17, fill: MUTED }),
    // requested is the number the proposed resource fee is charged on, so it
    // gets said plainly next to what the work actually cost
    cu.requestedMedian
      ? t(L, BY + BH + 52,
          `ASKS FOR ${compact(cu.requestedMedian)} · USES ${Math.round((cu.utilisation ?? 0) * 100)}% OF IT`,
          { size: 11, tracking: 1.6, weight: 600, fill: MUTED })
      : t(L, BY + BH + 52, `${cheapPct}% UNDER 2k · ${cu.failed} OF ${cu.n} FAILED`,
          { size: 11, tracking: 1.6, weight: 600, fill: MUTED }),
  );
  return { svg: out.join(""), next: BY + BH + 52 };
}

// --- footprint + framework -------------------------------------------------
// One text run with tspans. Hand-computing the advances produced four different
// gaps in a three-item row; letting the rasteriser lay it out gives even ones.
function footprintBlock(f: CardFacts, y: number, fy: number): string {
  const parts = [`<tspan font-size="21" font-weight="600">${esc(fmtSize(f.sizeBytes))}</tspan>`];
  if (f.instructionCount)
    parts.push(
      `<tspan font-size="21" font-weight="600">${f.instructionCount}</tspan>` +
        `<tspan font-size="17" fill="${MUTED}"> instructions</tspan>`,
    );
  if (f.syscallCount)
    parts.push(
      `<tspan font-size="21" font-weight="600">${f.syscallCount}</tspan>` +
        `<tspan font-size="17" fill="${MUTED}"> syscalls</tspan>`,
    );
  const sep = `<tspan font-size="17" fill="${FAINT}">&#160;&#160;·&#160;&#160;</tspan>`;
  return [
    t(L, y, "FOOTPRINT", { size: 10, tracking: 2, weight: 600, fill: MUTED }),
    `<text x="${L}" y="${y + 32}" font-family="Plex" fill="${INK}">${parts.join(sep)}</text>`,
    t(L, fy, "FRAMEWORK", { size: 10, tracking: 2, weight: 600, fill: MUTED }),
    t(L, fy + 30, String(f.framework ?? "unknown").toUpperCase(), { size: 22, weight: 600, tracking: 1.1 }),
  ].join("");
}

// --- reach: a trust tree ---------------------------------------------------
// Direction runs downward in trust. What this program NAMES sits above it —
// naming a program is depending on it. What names this program sits below.
//
// Both sides are compiled-in program ids: that proves the code names the other
// program, not that it calls it at runtime, so this under-reports rather than
// invents, and nothing is labelled "calls".
function reachBlock(f: CardFacts, y: number): string {
  const dedupe = (list: EdgeNode[]) => {
    const seen = new Set<string>();
    return list.filter((e) => e.name && !seen.has(e.name) && seen.add(e.name));
  };
  const up = dedupe(f.references.names);
  const down = dedupe(f.references.namedBy);
  const CAP = 3, ROW = 30, BOXH = 24;
  const SPINE = COL_R + 12, BX = COL_R + 30, BW = R - BX;
  const dash = (d: string) =>
    `<path d="${d}" stroke="${FAINT}" stroke-width="1.2" stroke-dasharray="4 6" fill="none"/>`;

  const out = [t(COL_R, y, "REACH", { size: 10, tracking: 2, weight: 600, fill: MUTED })];
  if (!up.length && !down.length) {
    out.push(t(COL_R, y + 30, "NO REFERENCES ON RECORD", { size: 11, tracking: 1.6, weight: 600, fill: MUTED }));
    return out.join("");
  }

  const rows = (list: EdgeNode[], y0: number) => {
    const shown = list.slice(0, CAP), more = list.length - shown.length;
    const boxes: string[] = [], labels: string[] = [];
    shown.forEach((e, i) => {
      const yy = y0 + i * ROW;
      boxes.push(
        dash(`M ${SPINE} ${yy + BOXH / 2} L ${BX} ${yy + BOXH / 2}`),
        `<rect x="${BX}" y="${yy}" width="${BW}" height="${BOXH}" rx="4" fill="none" stroke="${INK}" stroke-width="1.2"/>`,
      );
      const nm = e.name!.length > 24 ? `${e.name!.slice(0, 23)}…` : e.name!;
      labels.push(t(BX + 10, yy + 17, nm, { size: 14 }));
    });
    if (more > 0) {
      const yy = y0 + shown.length * ROW;
      boxes.push(dash(`M ${SPINE} ${yy + 11} L ${BX - 6} ${yy + 11}`));
      labels.push(t(BX, yy + 15, `+${more} MORE`, { size: 11, tracking: 1.6, weight: 600, fill: MUTED }));
    }
    return { boxes: boxes.join(""), labels: labels.join(""), n: shown.length + (more > 0 ? 1 : 0) };
  };

  const upTop = y + (up.length ? 34 : 0);
  const u = up.length ? rows(up, upTop) : { boxes: "", labels: "", n: 0 };
  const selfY = up.length ? upTop + u.n * ROW + 10 : y + 30;
  const SELFH = 28;
  const downTop = selfY + SELFH + (down.length ? 34 : 0);
  const d = down.length ? rows(down, downTop) : { boxes: "", labels: "", n: 0 };
  const trunkTop = up.length ? upTop + 12 : selfY;
  const trunkBot = down.length ? downTop + (d.n - 1) * ROW + 12 : selfY + SELFH;

  // a direction label is only drawn when it has something to label
  if (up.length) out.push(t(COL_R, upTop - 10, "TRUSTS", { size: 9, tracking: 1.7, weight: 600, fill: FAINT }));
  if (down.length) out.push(t(COL_R, downTop - 10, "TRUSTED BY", { size: 9, tracking: 1.7, weight: 600, fill: FAINT }));
  out.push(
    `<g filter="url(#rough)">
      ${dash(`M ${SPINE} ${trunkTop} L ${SPINE} ${trunkBot}`)}
      ${u.boxes}
      <rect x="${COL_R}" y="${selfY}" width="${R - COL_R}" height="${SELFH}" rx="4" fill="${INK}"/>
      ${d.boxes}
    </g>`,
    u.labels,
    t(COL_R + 12, selfY + 19, (f.name ?? "this program").slice(0, 26), { size: 14, fill: PAPER }),
    d.labels,
  );
  return out.join("");
}

// --- the activity graph, drawn as the rule above the footer ----------------
function graphBlock(f: CardFacts): { svg: string; note: string } {
  const GY = CARD_Y + CARD_H - 124, GH = 64, GW = R - L;
  const now = Date.now(), t0 = now - 7 * 24 * HOUR;
  const pts = (f.activity ?? []).filter((q) => q.t >= t0).sort((a, b) => a.t - b.t);
  const distinct = new Set(pts.map((q) => q.c)).size;
  // a series pinned at the sampler's ceiling has no shape to draw; drawing the
  // ceiling anyway renders a solid block that reads as real traffic
  const saturated = f.truncated && distinct <= 2;

  if (!pts.length || saturated) {
    return {
      svg:
        `<path d="M ${L} ${GY + GH} L ${R} ${GY + GH}" stroke="${FAINT}" stroke-width="1.2" stroke-dasharray="4 6" fill="none"/>` +
        t((L + R) / 2, GY + GH / 2 + 5,
          saturated ? "MORE TRAFFIC THAN THE SAMPLER CAN COUNT" : "NO TRAFFIC IN THE LAST 7 DAYS",
          { size: 12, tracking: 2, weight: 600, fill: FAINT, anchor: "middle" }),
      note: "",
    };
  }

  const total = pts.reduce((a, q) => a + q.c, 0);
  const peak = Math.max(1, ...pts.map((q) => q.c));
  // scaled to the span actually sampled — a series drawn across a 7-day axis it
  // only half covers reads as truncated data
  const first = pts[0]!.t, last = pts[pts.length - 1]!.t;
  const span = Math.max(1, last - first);
  const x = (ts: number) => L + ((ts - first) / span) * GW;
  const y = (c: number) => GY + GH - (c / peak) * (GH - 8);
  const line = pts.map((q) => `${x(q.t).toFixed(1)},${y(q.c).toFixed(1)}`).join(" ");
  const x0 = x(first).toFixed(1), x1 = x(last).toFixed(1);
  const days = Math.max(1, Math.round(span / 86_400_000));
  return {
    svg: `<g filter="url(#rough)">
      <polygon points="${x0},${GY + GH} ${line} ${x1},${GY + GH}" fill="${BRAND}" opacity="0.14"/>
      <polyline points="${line}" fill="none" stroke="${BRAND}" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M ${L} ${GY + GH} L ${R} ${GY + GH}" stroke="${FAINT}" stroke-width="1.2" stroke-dasharray="4 6" fill="none"/>
    </g>`,
    note: `${total.toLocaleString("en-US")}${f.truncated ? "+" : ""} TXNS / ${days} DAYS`,
  };
}

/** The card as one SVG document. */
export function cardSvg(f: CardFacts, logoDataUri: string | null = null): string {
  const auth = authority(f.authorityClass, f.multisig);
  const isRatio = /^\d/.test(auth);
  const nameText = f.name ?? "unnamed program";
  const nameX = L + 46;
  const nameY = CARD_Y + 78;
  const nameW = textW(nameText, 38);
  const g = graphBlock(f);
  const cmp = computeBlock(f.compute, CARD_Y + 150);
  // the footprint follows the compute block rather than sitting at a fixed y,
  // so a program without a reading does not leave the bar's band empty
  const fpY = cmp.next + 56;
  const kicker = [
    "PROGRAM",
    f.firstDeployAt ? `deployed ${fullDate(f.firstDeployAt)}` : null,
    f.upgradeCount ? `upgraded ×${f.upgradeCount}${f.upgradeTruncated ? "+" : ""}` : null,
  ].filter(Boolean).join("   ·   ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    <filter id="rough" x="-5%" y="-20%" width="110%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.021" numOctaves="3" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="0.85" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <clipPath id="card"><rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="12"/></clipPath>
  </defs>
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#eceae4"/>
  <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="${PAPER}" stroke="#d8d8d2" stroke-width="1"/>
  <g clip-path="url(#card)">
    ${t(L, CARD_Y + 34, kicker, { size: 10, tracking: 2.2, weight: 600, fill: MUTED })}
    ${
      logoDataUri
        ? `<image href="${logoDataUri}" x="${L}" y="${nameY - 29}" width="34" height="34" preserveAspectRatio="xMidYMid meet"/>`
        : `<rect x="${L}" y="${nameY - 29}" width="34" height="34" rx="9" fill="#eceae4" stroke="#d8d8d2" stroke-width="1"/>` +
          t(L + 17, nameY - 7, f.programId.slice(0, 2), { size: 15, weight: 600, fill: MUTED, anchor: "middle" })
    }
    ${t(nameX, nameY, nameText, { size: 38, weight: 600 })}
    ${
      f.verified
        ? `<g transform="translate(${nameX + nameW + 16} ${nameY - 17})"><path d="${VERIFIED_DISC}" fill="${GREEN}" transform="scale(0.88)"/><path d="M7.4 12.3l3.1 3.1 6.1-6.4" fill="none" stroke="${PAPER}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="scale(0.88)"/></g>` +
          t(nameX + nameW + 42, nameY - 3, "VERIFIED", { size: 10, tracking: 1.8, weight: 600, fill: GREEN })
        : ""
    }
    ${t(L, CARD_Y + 106, f.programId, { size: 13, tracking: 0.5, fill: MUTED })}

    ${t(R, CARD_Y + 38, "AUTHORITY", { size: 10, tracking: 2, weight: 600, fill: MUTED, anchor: "end" })}
    ${t(R, CARD_Y + 64, auth, { size: isRatio ? 26 : 19, weight: 600, tracking: isRatio ? 1.2 : 0.4, anchor: "end" })}

    ${cmp.svg}
    ${footprintBlock(f, fpY, fpY + 90)}
    ${reachBlock(f, CARD_Y + 150)}

    ${g.svg}
    ${g.note ? t(L, CARD_Y + CARD_H - 20, g.note, { size: 12, tracking: 1.9, weight: 600, fill: MUTED }) : ""}
    <g transform="translate(${R - textW("ON-RECORD.AZUOLAS.XYZ", 12, 1.9) - 24} ${CARD_Y + CARD_H - 31})">
      <svg width="14" height="14" viewBox="0 0 329 329"><path d="${ORB_RING}" fill="${BRAND}"/><circle cx="164.5" cy="164.5" r="66" fill="${BRAND}"/></svg>
    </g>
    ${t(R, CARD_Y + CARD_H - 20, "ON-RECORD.AZUOLAS.XYZ", { size: 12, tracking: 1.9, weight: 600, fill: MUTED, anchor: "end" })}
  </g>
</svg>`;
}

/**
 * Rasterise to PNG. 2400x1400 — twice the authored size, which is what X wants
 * for a landscape image.
 *
 * System fonts are off on purpose: the container has none, and a card that
 * renders differently on a different machine is not a record of anything.
 */
export function renderCard(f: CardFacts, logoDataUri: string | null = null): Buffer {
  return Buffer.from(
    new Resvg(cardSvg(f, logoDataUri), {
      fitTo: { mode: "width", value: CANVAS_W * 2 },
      font: { fontFiles: FONT_FILES, defaultFontFamily: "Plex", loadSystemFonts: false },
    })
      .render()
      .asPng(),
  );
}

/** Facts to PNG in one call, for the route and the bot alike. */
export async function renderCardFor(programId: string): Promise<Buffer | null> {
  const facts = await cardFacts(programId);
  if (!facts) return null;
  // A card is the one place the gap is visible, so this is where it gets
  // closed: no stored reading means take one now, budgeted and written through
  // so the next caller — the bot, the dossier, the API — finds it there.
  if (!facts.compute) {
    facts.compute = await sampleComputeOnDemand(facts.network, programId);
  }
  return renderCard(facts, await fetchIcon(facts));
}
