import type { ApiProgram } from "@/lib/api";

type AvatarSource = Pick<ApiProgram, "id" | "website" | "social" | "repoUrl" | "network">;

/** Best URL to source a favicon from: an explicit website, else a github/x link. */
function faviconUrl(program: AvatarSource): string | null {
  const src = program.website ?? program.social ?? program.repoUrl;
  if (!src) return null;
  try {
    const host = new URL(src).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  } catch {
    return null;
  }
}

/** A program's icon: a real favicon when we can source one, else an Orb-style
 *  two-char avatar from the program id. Shared by the radar card and the dossier.
 *
 *  Devnet programs get an accent ring. The merged feed mixes clusters and that is
 *  the single biggest thing to know about a row, so it reads as colour on a
 *  fixed anchor rather than as another chip to parse — the icon is in the same
 *  place on every row, so the difference is visible before any text is. */
export function ProgramAvatar({ program, size = 18 }: { program: AvatarSource; size?: number }) {
  const favicon = faviconUrl(program);
  const devnet = program.network === "devnet";
  const cls = devnet ? " is-devnet" : "";
  const title = devnet ? "Devnet program" : undefined;
  const box = { width: size, height: size, borderRadius: Math.max(4, Math.round(size / 3.5)) };
  if (favicon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={`radar-favicon${cls}`}
        src={favicon}
        alt=""
        title={title}
        width={size}
        height={size}
        loading="lazy"
        style={box}
      />
    );
  }
  return (
    <span
      className={`radar-favicon radar-avatar${cls}`}
      title={title}
      aria-hidden={devnet ? undefined : true}
      aria-label={devnet ? "Devnet program" : undefined}
      style={{ ...box, fontSize: Math.max(8.5, Math.round(size * 0.42)) }}
    >
      {program.id.slice(0, 2)}
    </span>
  );
}
