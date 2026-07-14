import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { deriveSignals, type Signal } from "@/lib/signals";
import { fetchProgram } from "@/lib/api";
import { formatBytes, truncateAddress } from "@/lib/format";

// ---------------------------------------------------------------------------
// Share card: og:image for a program dossier. Name + facts on the left, the
// signal pentagon on the right — the same silhouette the radar cards show,
// sized for a Twitter/Discord unfurl. Light theme constants (unfurls render
// on the platform's surface, not ours; one deliberate look beats guessing).
// ---------------------------------------------------------------------------

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Program signal card — On Record";

const BG = "#fafafa";
const CARD = "#ffffff";
const BORDER = "#e5e5e5";
const INK = "#171717";
const INK_SOFT = "#525252";
const INK_FAINT = "#8f8f8f";
const ACCENT = "#e8432c";

function pentagonPoints(signals: Signal[], r: number, c: number, scaleFor: (s: Signal) => number): string {
  const n = signals.length;
  return signals
    .map((s, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const k = scaleFor(s);
      return `${(c + r * k * Math.cos(a)).toFixed(1)},${(c + r * k * Math.sin(a)).toFixed(1)}`;
    })
    .join(" ");
}

/** cwd differs between monorepo dev (repo root) and Vercel (apps/web) — try both */
async function loadFont(file: string): Promise<Buffer> {
  const candidates = [
    join(process.cwd(), "assets/og", file),
    join(process.cwd(), "apps/web/assets/og", file),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p);
    } catch {
      /* try next */
    }
  }
  throw new Error(`og font not found: ${file}`);
}

/** Best icon URL for a program: its developer-declared on-chain logo, else a
 *  favicon sourced from its linked site/social/repo (same fallback the site's
 *  ProgramAvatar uses). null when there's nothing to source. */
function logoSource(p: {
  logoUrl: string | null;
  website: string | null;
  social: string | null;
  repoUrl: string | null;
}): string | null {
  if (p.logoUrl) return p.logoUrl;
  const src = p.website ?? p.social ?? p.repoUrl;
  if (!src) return null;
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(src).hostname}&sz=128`;
  } catch {
    return null;
  }
}

/** Fetch an icon and inline it as a data URI — Satori renders remote images
 *  unreliably, so we embed the bytes. Skips SVG (not rasterized), oversized
 *  images, and any failure — the card just renders without a logo. */
async function loadLogo(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/") || type.includes("svg")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 512_000) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function OgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [program, fontRegular, fontSemiBold] = await Promise.all([
    fetchProgram(id),
    loadFont("IBMPlexMono-Regular.ttf"),
    loadFont("IBMPlexMono-SemiBold.ttf"),
  ]);

  const fonts = [
    { name: "Plex Mono", data: fontRegular, weight: 400 as const, style: "normal" as const },
    { name: "Plex Mono", data: fontSemiBold, weight: 600 as const, style: "normal" as const },
  ];

  const logo = program ? await loadLogo(logoSource(program)) : null;

  if (!program) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: BG,
            color: INK,
            fontSize: 44,
            fontFamily: "Plex Mono",
          }}
        >
          on record
        </div>
      ),
      { ...size, fonts },
    );
  }

  const signals = deriveSignals(program);
  const name = program.name ?? truncateAddress(program.id);
  const facts = [
    program.framework && program.framework !== "unknown" ? program.framework : null,
    program.category && program.category !== "unknown" ? program.category : null,
    program.sizeBytes ? formatBytes(program.sizeBytes) : null,
    program.deployCostSol != null ? `${program.deployCostSol} SOL rent` : null,
  ].filter(Boolean) as string[];

  // the deploy / upgrade moment, full UTC — a fixed point in time, never stale
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtUTC = (iso: string): string => {
    const d = new Date(iso);
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  };
  const stampIso =
    (program.deployType === "upgrade" ? program.lastEventAt : null) ??
    program.deployedAt ??
    program.firstDeployAt ??
    null;
  const stamp = stampIso
    ? `${program.deployType === "upgrade" ? "Upgraded" : "Deployed"} ${fmtUTC(stampIso)}`
    : null;

  // pentagon geometry: 340px box, labels placed around it
  const box = 340;
  const c = box / 2;
  const r = box / 2 - 10;
  const labelR = r + 26;
  const labels = signals.map((s, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / signals.length;
    return {
      label: s.label,
      x: c + labelR * Math.cos(a),
      y: c + labelR * Math.sin(a),
    };
  });

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: BG,
          padding: 36,
          fontFamily: "Plex Mono",
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: CARD,
            border: `2px solid ${BORDER}`,
            borderRadius: 8,
            padding: "40px 52px",
          }}
        >
          {/* header line */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              color: INK_FAINT,
              fontSize: 22,
              letterSpacing: 2,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span
                style={{
                  width: 16,
                  height: 16,
                  background: ACCENT,
                  borderRadius: 999,
                  display: "flex",
                }}
              />
              ON RECORD
            </span>
            <span>{program.deployType === "upgrade" ? "UPGRADED PROGRAM" : "NEW PROGRAM"}</span>
          </div>

          <div style={{ display: "flex", flex: 1, alignItems: "flex-start", gap: 40 }}>
            {/* left column: name is the title up top, a divider, then the timestamp */}
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 8 }}>
                {logo ? (
                  <img
                    width={72}
                    height={72}
                    src={logo}
                    style={{
                      borderRadius: 14,
                      border: `2px solid ${BORDER}`,
                      objectFit: "cover",
                      flexShrink: 0,
                    }}
                  />
                ) : null}
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: name.length > 18 ? (logo ? 40 : 44) : logo ? 50 : 58,
                      fontWeight: 600,
                      color: INK,
                    }}
                  >
                    {name}
                  </div>
                  <div style={{ fontSize: 20, color: INK_FAINT, marginTop: 6 }}>
                    {truncateAddress(program.id)}
                  </div>
                </div>
              </div>

              {facts.length ? (
                <div style={{ display: "flex", gap: 12, marginTop: 26, flexWrap: "wrap" }}>
                  {facts.map((f) => (
                    <span
                      key={f}
                      style={{
                        border: `2px solid ${BORDER}`,
                        borderRadius: 4,
                        padding: "6px 14px",
                        fontSize: 20,
                        color: INK_SOFT,
                      }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              ) : null}

              {stamp ? (
                <>
                  <div style={{ display: "flex", height: 2, background: BORDER, marginTop: 40 }} />
                  <div style={{ display: "flex", fontSize: 24, color: INK_SOFT, marginTop: 24 }}>
                    {stamp}
                  </div>
                </>
              ) : null}
            </div>

            {/* right column: the pentagon (kept vertically centred) */}
            <div
              style={{
                display: "flex",
                position: "relative",
                width: box + 60,
                height: box + 30,
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                alignSelf: "center",
              }}
            >
              <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`}>
                <polygon points={pentagonPoints(signals, r, c, () => 1)} fill="none" stroke={BORDER} strokeWidth={2} />
                <polygon points={pentagonPoints(signals, r, c, () => 0.5)} fill="none" stroke={BORDER} strokeWidth={2} />
                <polygon
                  points={pentagonPoints(signals, r, c, (s) => Math.max(0.06, s.value))}
                  fill="rgba(232,67,44,0.14)"
                  stroke={ACCENT}
                  strokeWidth={3}
                />
              </svg>
              {labels.map((l) => (
                <span
                  key={l.label}
                  style={{
                    position: "absolute",
                    left: l.x + 30, // svg sits at (30,15) inside the padded box
                    top: l.y + 15 - 12,
                    transform: "translateX(-50%)",
                    fontSize: 17,
                    letterSpacing: 1.5,
                    color: INK_FAINT,
                  }}
                >
                  {l.label}
                </span>
              ))}
            </div>
          </div>

          {/* footer */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              color: INK_FAINT,
              fontSize: 19,
            }}
          >
            <span>Strip the copy-paste. Rank what&apos;s new.</span>
            <span style={{ color: INK_SOFT }}>the novel-program radar for Solana</span>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
