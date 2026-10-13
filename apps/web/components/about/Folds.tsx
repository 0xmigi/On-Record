"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * The page's sections, folded. Each one is its ruled section header (the
 * site's own, label then stacked lines); one is open at a time and they take
 * turns while the block is on screen, the open header's lines inking in from
 * the left as its turn runs. It holds under the pointer and stops for good at
 * the first click or tap inside, so anyone who wants to read one can open it
 * and keep it. Every panel is as tall as the tallest, so nothing around the
 * block moves as they change. On a phone the panels are taller than the screen
 * and very unequal, so there it is a plain tap-to-open accordion at natural
 * heights and never advances by itself. With prefers-reduced-motion it never
 * advances either; with no JavaScript every panel is simply open (the folding
 * is armed by AboutMotion's .about-armed).
 */

const NARROW = "(max-width: 759px)";

/** `dur` is how long its turn lasts, in seconds. */
export type Fold = { id: string; label: string; dur?: number; body: ReactNode };

export function Folds({ items }: { items: Fold[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(0);
  const [live, setLive] = useState(false);
  const [manual, setManual] = useState(false);
  const [wide, setWide] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // hold every panel at the height of the tallest
    const contents = Array.from(el.querySelectorAll<HTMLElement>(".about-fold-content"));
    const measure = () => {
      const max = Math.max(0, ...contents.map((c) => c.offsetHeight));
      el.style.setProperty("--fold-h", `${max}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const c of contents) ro.observe(c);

    const narrow = window.matchMedia(NARROW);
    const onNarrow = () => setWide(!narrow.matches);
    onNarrow();
    narrow.addEventListener("change", onNarrow);

    let io: IntersectionObserver | undefined;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      io = new IntersectionObserver(([e]) => setLive(e.isIntersecting), { threshold: 0.35 });
      io.observe(el);
    }
    return () => {
      ro.disconnect();
      io?.disconnect();
      narrow.removeEventListener("change", onNarrow);
    };
  }, []);

  const running = live && wide && !manual;

  const pick = (i: number, row: HTMLElement | null) => {
    setManual(true);
    setOpen(i);
    // a tall panel closing above can carry the heading just opened off the screen
    window.setTimeout(() => row?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 740);
  };

  return (
    <div className="about-folds" ref={ref} onPointerDown={() => setManual(true)}>
      {items.map((it, i) => (
        <section className={i === open ? "about-fold is-open" : "about-fold"} key={it.id}>
          <button
            type="button"
            className="about-fold-btn"
            aria-expanded={i === open}
            aria-controls={`about-fold-${it.id}`}
            onClick={(e) => pick(i, e.currentTarget)}
          >
            <span className="section-header about-fold-label">
              {it.label}
              <span className="about-fold-rule" aria-hidden="true">
                {i === open && (
                  <i
                    className={running ? "run" : undefined}
                    style={{ animationDuration: `${it.dur ?? 9}s` }}
                    onAnimationEnd={() => setOpen((o) => (o + 1) % items.length)}
                  />
                )}
              </span>
              <span className="about-fold-mark" aria-hidden="true" />
            </span>
          </button>
          <div className="about-fold-panel" id={`about-fold-${it.id}`}>
            <div className="about-fold-body">
              <div className="about-fold-in">
                <div className="about-fold-content">{it.body}</div>
              </div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
