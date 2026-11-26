"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { squarify } from "@/lib/treemap";

// Ranked counts as one box split into blocks, each sized by its count and
// named inside (bigger and darker = more). The biggest few get blocks of their
// own; the tail is one "N more" block that zooms in to a box of its own when
// clicked, grouped again the same way, so every item is readable at some level.
// Two box shapes, wide and narrow, so blocks stay near-square on a phone.

type Item = { name: string; n: number };
type Block = Item & { more?: Item[] };

const fmt = (n: number) => n.toLocaleString("en-US");

/** Items with at least SHARE of the level's references get blocks of their
 *  own (at least three, at most ten); the rest fold into one "N more" block,
 *  pinned last. A fold of one item is just that item. */
const SHARE = 0.03;

function group(items: Item[]): Block[] {
  const total = items.reduce((a, i) => a + i.n, 0);
  let head = items.filter((i) => i.n >= total * SHARE).length;
  head = Math.min(10, Math.max(3, head));
  if (items.length - head < 2) return items;
  const tail = items.slice(head);
  return [...items.slice(0, head), { name: `${tail.length} more`, n: tail.reduce((a, i) => a + i.n, 0), more: tail }];
}

export function DrillTreemap({ items }: { items: [string, number][] }) {
  const all: Item[] = [...items].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  // the path of "more" blocks clicked into
  const [path, setPath] = useState<Item[][]>([]);
  const level = path.length ? path[path.length - 1] : all;
  const blocks = group(level);
  const max = Math.max(1, ...blocks.filter((b) => !b.more).map((b) => b.n));

  // Print every name, then hide the ones the real rendered text overflows:
  // measured, not estimated. Count goes first, name only if still too tight.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const fit = () => {
      for (const fill of root.querySelectorAll<HTMLElement>(".tm-fill")) {
        fill.classList.remove("no-n", "no-name");
        const over = () => fill.scrollHeight > fill.clientHeight + 1 || fill.scrollWidth > fill.clientWidth + 1;
        if (over()) fill.classList.add("no-name");
        if (over()) fill.classList.add("no-n");
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(root);
    return () => ro.disconnect();
  }, [path]);

  const box = (aspect: number, cls: string) => (
    <div className={`treemap ${cls}`} role="group" aria-label="Integrations by how many programs reference them">
      {squarify(
        blocks.map((b) => ({ item: b, value: b.n })),
        aspect,
        true,
      ).map(({ item, x, y, w, h }) => {
        // the "more" block stays pale: it is a door, not a program
        const ink = item.more ? 10 : Math.round(18 + (item.n / max) * 62);
        const style = {
          left: `${x}%`,
          top: `${y}%`,
          width: `${w}%`,
          height: `${h}%`,
          ["--tm-ink" as string]: `${ink}%`,
        };
        const inner = (
          <span className="tm-fill">
            <span className="tm-name">{item.more ? `${item.name} →` : item.name}</span>
            <span className="tm-n">{fmt(item.n)}</span>
            {/* the door keeps a label even when tiny */}
            {item.more ? <span className="tm-short">+{item.more.length}</span> : null}
          </span>
        );
        return item.more ? (
          <button
            key={item.name}
            type="button"
            className="tm-block tm-more"
            style={style}
            title={item.more.map((i) => `${i.name} ${fmt(i.n)}`).join(" · ")}
            onClick={() => setPath((p) => [...p, item.more!])}
          >
            {inner}
          </button>
        ) : (
          <span
            key={item.name}
            className={`tm-block${ink >= 46 ? " is-dark" : ""}`}
            style={style}
            data-name={item.name}
            title={`${item.name} ${fmt(item.n)}`}
          >
            {inner}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="drill" ref={rootRef}>
      {path.length ? (
        <div className="drill-crumbs">
          <button type="button" className="drill-back" onClick={() => setPath((p) => p.slice(0, -1))}>
            ← back
          </button>
        </div>
      ) : null}
      {box(3.6, "tm-wide")}
      {box(0.9, "tm-narrow")}
    </div>
  );
}
