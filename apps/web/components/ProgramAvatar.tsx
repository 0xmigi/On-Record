import type { ApiProgram } from "@/lib/api";

type AvatarSource = Pick<ApiProgram, "id" | "website" | "social" | "repoUrl">;

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
 *  two-char avatar from the program id. Shared by the radar card and the dossier. */
export function ProgramAvatar({ program, size = 18 }: { program: AvatarSource; size?: number }) {
  const favicon = faviconUrl(program);
  const box = { width: size, height: size, borderRadius: Math.max(4, Math.round(size / 3.5)) };
  if (favicon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="radar-favicon"
        src={favicon}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        style={box}
      />
    );
  }
  return (
    <span
      className="radar-favicon radar-avatar"
      aria-hidden="true"
      style={{ ...box, fontSize: Math.max(8.5, Math.round(size * 0.42)) }}
    >
      {program.id.slice(0, 2)}
    </span>
  );
}
