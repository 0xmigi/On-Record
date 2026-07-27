import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** cwd differs between monorepo dev (repo root) and Vercel (apps/web) — try both */
export async function loadOgFont(file: string): Promise<Buffer> {
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

/** Share-card palette. Unfurls render on the platform's surface, not ours, so
 *  the cards commit to the light theme rather than guessing the viewer's. */
export const OG = {
  bg: "#fafafa",
  card: "#ffffff",
  border: "#e5e5e5",
  ink: "#171717",
  inkSoft: "#525252",
  inkFaint: "#8f8f8f",
  accent: "#e8432c",
} as const;
