"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/**
 * The problem section's three numbers, one at a time. All three stay on the
 * page as the row of tabs; one sheet of 40 programs underneath re-shades for
 * whichever is up (6 of 40, then 2, then 1). It advances by itself while it is
 * on screen, starting from the first each time it comes into view, holds under
 * the pointer, and stops for good once a tab is clicked. With
 * prefers-reduced-motion it never advances.
 */

const STATS = [
  { num: "7", label: "publish an IDL", on: 6 },
  { num: "20", label: "have a security.txt", on: 2 },
  { num: "40", label: "have a verified build", on: 1 },
];
const BITS = "0110110111000110111100100000011101001111";

export function StatReel() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [live, setLive] = useState(false);
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      ([e]) => {
        setLive(e.isIntersecting);
        // back to the first number whenever it comes on screen (its fold opening, say)
        if (e.isIntersecting) setActive((a) => (manualRef.current ? a : 0));
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { on } = STATS[active];
  const running = live && !manual;

  return (
    <div className="about-reel" ref={ref}>
      <div className="about-reel-tabs">
        {STATS.map((s, i) => (
          <button
            type="button"
            key={s.num}
            className={i === active ? "about-reel-tab on" : "about-reel-tab"}
            aria-pressed={i === active}
            onClick={() => {
              manualRef.current = true;
              setManual(true);
              setActive(i);
            }}
          >
            <span className="about-reel-bar" aria-hidden="true">
              {i === active && (
                <i
                  className={running ? "run" : undefined}
                  onAnimationEnd={() => setActive((a) => (a + 1) % STATS.length)}
                />
              )}
            </span>
            <span className="about-stat-num">
              <span className="about-dim">1 in</span> {s.num}
            </span>
            <span className="about-stat-label">{s.label}</span>
          </button>
        ))}
      </div>

      <div className={`about-bits tone-${active + 1}`} aria-hidden="true">
        {BITS.split("").map((b, i) =>
          i === 0 ? (
            // the first program is the one that ends up verified: it carries the tick
            <i key={i} className="on" style={{ "--k": 0 } as CSSProperties}>
              <span>{b}</span>
              <svg viewBox="0 0 52 52">
                <path pathLength={1} d="M 15 27 L 23 35 L 38 17" />
              </svg>
            </i>
          ) : (
            <i key={i} className={i < on ? "on" : undefined} style={{ "--k": i } as CSSProperties}>
              {b}
            </i>
          ),
        )}
      </div>
    </div>
  );
}
