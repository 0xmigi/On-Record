import { ImageResponse } from "next/og";
import { loadOgFont, OG } from "@/lib/og";
import { ORB_RING, MARK_CENTRE, MARK_DOT_R } from "@/components/Mark";

// ---------------------------------------------------------------------------
// Share card for every route that doesn't ship its own (the dossier does).
// Without this file the site had no og:image at all, so X rendered the small
// summary tile with a placeholder icon — the link looked like a broken page.
// Deliberately data-free: an unfurl that depends on the API would show a
// half-empty card the moment the backend hiccups. Kept to three elements —
// the platform already prints og:description and the domain underneath, so
// repeating them on the card is noise the reader has to skip twice.
// ---------------------------------------------------------------------------

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "On Record — the novel-program radar for Solana";

export default async function OgImage() {
  const [fontRegular, fontSemiBold] = await Promise.all([
    loadOgFont("IBMPlexMono-Regular.ttf"),
    loadOgFont("IBMPlexMono-SemiBold.ttf"),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: 48,
          background: OG.bg,
          fontFamily: "Plex Mono",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            background: OG.card,
            border: `1px solid ${OG.border}`,
            borderRadius: 8,
            padding: "44px 52px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              color: OG.inkFaint,
              fontSize: 22,
              letterSpacing: 2,
            }}
          >
            <svg width={30} height={30} viewBox="0 0 329 329">
              <path d={ORB_RING} fill={OG.accent} />
              <circle cx={MARK_CENTRE} cy={MARK_CENTRE} r={MARK_DOT_R} fill={OG.accent} />
            </svg>
            ON RECORD
          </div>

          <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 48 }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  whiteSpace: "nowrap",
                  fontSize: 64,
                  fontWeight: 600,
                  lineHeight: 1.15,
                  letterSpacing: -1,
                  color: OG.ink,
                }}
              >
                the novel-program
              </div>
              <div
                style={{
                  display: "flex",
                  whiteSpace: "nowrap",
                  fontSize: 64,
                  fontWeight: 600,
                  lineHeight: 1.15,
                  letterSpacing: -1,
                  color: OG.ink,
                }}
              >
                radar for Solana
              </div>
            </div>

            {/* the mark at a size where the ring's segments actually read */}
            <div style={{ display: "flex", flexShrink: 0 }}>
              <svg width={236} height={236} viewBox="0 0 329 329">
                <path d={ORB_RING} fill={OG.accent} />
                <circle cx={MARK_CENTRE} cy={MARK_CENTRE} r={MARK_DOT_R} fill={OG.accent} />
              </svg>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              color: OG.inkFaint,
              fontSize: 20,
              letterSpacing: 1.6,
            }}
          >
            <span>STRIP THE COPY-PASTE. RANK WHAT&apos;S NEW.</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Plex Mono", data: fontRegular, weight: 400, style: "normal" },
        { name: "Plex Mono", data: fontSemiBold, weight: 600, style: "normal" },
      ],
    },
  );
}
