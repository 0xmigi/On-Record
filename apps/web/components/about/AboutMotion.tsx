"use client";

import { useEffect } from "react";

/**
 * The about page's motion, kept out of the markup so the page itself stays a
 * static server render that reads fine with no JavaScript at all:
 *  - arms the scroll reveals (`[data-reveal]` gets `.is-in` when it scrolls
 *    into view; anything already on screen at load is never hidden first)
 *  - keeps the 0/1 grids alive by flipping a few unshaded cells at random
 *  - holds every looping SVG animation still for prefers-reduced-motion
 */
export function AboutMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".about");
    if (!root) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    for (const el of targets) {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.9) el.classList.add("is-in");
    }
    root.classList.add("about-armed");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { threshold: 0.2, rootMargin: "0px 0px -6% 0px" },
    );
    for (const el of targets) if (!el.classList.contains("is-in")) io.observe(el);

    let timer = 0;
    if (reduce) {
      root.querySelectorAll("svg").forEach((s) => s.pauseAnimations?.());
    } else {
      const cells = Array.from(root.querySelectorAll<HTMLElement>(".about-bits i:not(.on)"));
      timer = window.setInterval(() => {
        if (document.hidden) return;
        for (let k = 0; k < 3; k++) {
          const c = cells[Math.floor(Math.random() * cells.length)];
          if (!c) continue;
          c.textContent = c.textContent === "0" ? "1" : "0";
          c.classList.remove("flip");
          void c.offsetWidth;
          c.classList.add("flip");
        }
      }, 170);
    }

    return () => {
      io.disconnect();
      window.clearInterval(timer);
      root.classList.remove("about-armed");
    };
  }, []);

  return null;
}
