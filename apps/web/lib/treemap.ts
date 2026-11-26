// Squarified treemap layout (Bruls, Huizing & van Wijk): lays out values,
// largest first, as rectangles whose areas are proportional to the values and
// whose shapes stay as close to square as the space allows. Coordinates come
// back as percentages of the box, so the page can position blocks with CSS.

export type TreemapRect<T> = { item: T; x: number; y: number; w: number; h: number };

/** `aspect` = box width ÷ height, so blocks come out square on screen. */
export function squarify<T>(
  items: { item: T; value: number }[],
  aspect: number,
  /** keep the given order (e.g. an "N more" block pinned last) instead of largest first */
  keepOrder = false,
): TreemapRect<T>[] {
  const W = aspect;
  const H = 1;
  const total = items.reduce((a, i) => a + i.value, 0);
  if (total <= 0) return [];
  const scaled = items
    .filter((i) => i.value > 0)
    .sort((a, b) => (keepOrder ? 0 : b.value - a.value))
    .map((i) => ({ item: i.item, area: (i.value / total) * W * H }));

  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, v) => a + v, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const out: TreemapRect<T>[] = [];
  let x = 0;
  let y = 0;
  let w = W;
  let h = H;
  let rest = scaled;
  while (rest.length) {
    const side = Math.min(w, h);
    let n = 1;
    while (
      n < rest.length &&
      worst(rest.slice(0, n + 1).map((r) => r.area), side) <= worst(rest.slice(0, n).map((r) => r.area), side)
    )
      n++;
    const row = rest.slice(0, n);
    const sum = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      // a column down the left edge
      const cw = sum / h;
      let cy = y;
      for (const r of row) {
        const rh = r.area / cw;
        out.push({ item: r.item, x, y: cy, w: cw, h: rh });
        cy += rh;
      }
      x += cw;
      w -= cw;
    } else {
      // a row along the top edge
      const rh = sum / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ item: r.item, x: cx, y, w: rw, h: rh });
        cx += rw;
      }
      y += rh;
      h -= rh;
    }
    rest = rest.slice(n);
  }
  return out.map((r) => ({ ...r, x: (r.x / W) * 100, y: (r.y / H) * 100, w: (r.w / W) * 100, h: (r.h / H) * 100 }));
}
