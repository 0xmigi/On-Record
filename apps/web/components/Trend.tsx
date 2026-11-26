// A change tag: "↑ 14pp" in the accent colour, either way, nothing when
// flat. It marks that a share moved, not whether that is good.

/** Changes at or under this many points read as flat and draw nothing. */
const FLAT_PP = 2;

/** `pp`: the change in percentage points; `title`: what it compares. */
export function Trend({ pp, title }: { pp: number | null | undefined; title?: string }) {
  if (pp == null || Math.abs(pp) <= FLAT_PP) return null;
  const up = pp > 0;
  return (
    <span className={`trend-pill ${up ? "is-up" : "is-down"}`} title={title}>
      {up ? "↑" : "↓"} {Math.abs(pp)}pp
    </span>
  );
}
