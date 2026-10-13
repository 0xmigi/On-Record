"use client";

import { useEffect, useRef } from "react";

/**
 * The field behind the hero and the close: On Record's own picture of the
 * chain. A sheet of 0/1 cells (the same cells as the problem section's grids)
 * that keep flipping, and every so often one is "found": the cell turns red
 * and a marker ring is drawn around it by hand, the way the deck circles
 * things. Cells wake up under the pointer. Colours come from the page's CSS
 * variables, so it follows light and dark. Canvas, ~30fps, paused off-screen,
 * one still frame for prefers-reduced-motion.
 */

const PITCH = 34;
const CELL = 27;

type Find = { col: number; row: number; t0: number; ring: [number, number][] };

/** A circle drawn like a marker would: a little uneven, and it overshoots its start. */
function markerRing(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  const start = Math.random() * Math.PI * 2;
  const squash = 0.86 + Math.random() * 0.2;
  const tilt = (Math.random() - 0.5) * 0.7;
  const steps = 44;
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const a = start + p * Math.PI * 2 * 1.09;
    const rr = r * (1 + 0.07 * Math.sin(a * 3 + start) + p * 0.1);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr * squash;
    pts.push([cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)]);
  }
  return pts;
}

export function BitField({ seed = 1 }: { seed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let bits = new Uint8Array(0);
    let flipped = new Float64Array(0); // when each cell last flipped
    let finds: Find[] = [];
    let raf = 0;
    let onScreen = true;
    let lastFrame = 0;
    let lastFind = 0;
    let mx = -9999;
    let my = -9999;
    let c = { cell: "", digit: "", ink: "", red: "", box: "" };
    let font = "500 13px monospace";

    const readTheme = () => {
      const cs = getComputedStyle(host);
      const v = (n: string) => cs.getPropertyValue(n).trim();
      c = { cell: v("--a-cell"), digit: v("--a-rule"), ink: v("--a-ink"), red: v("--a-red"), box: v("--box") };
      font = `500 13px ${v("--font-plex-mono") || "ui-monospace"}, ui-monospace, monospace`;
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / PITCH) + 1;
      rows = Math.ceil(h / PITCH) + 1;
      // deterministic start so the server-free first frame is stable per seed
      let s = seed * 9301 + 49297;
      bits = new Uint8Array(cols * rows);
      for (let i = 0; i < bits.length; i++) {
        s = (s * 9301 + 49297) % 233280;
        bits[i] = s / 233280 > 0.5 ? 1 : 0;
      }
      flipped = new Float64Array(cols * rows).fill(-1e9);
      finds = [];
    };

    const cellRect = (col: number, row: number) => {
      const x = col * PITCH + (PITCH - CELL) / 2;
      const y = row * PITCH + (PITCH - CELL) / 2;
      return [x, y] as const;
    };
    const box = (x: number, y: number) => {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, CELL, CELL, 6);
      else ctx.rect(x, y, CELL, CELL);
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1.5;
      const found = new Map<number, Find>();
      for (const f of finds) found.set(f.row * cols + f.col, f);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col;
          const [x, y] = cellRect(col, row);
          const cx = x + CELL / 2;
          const cy = y + CELL / 2;
          const near = Math.max(0, 1 - Math.hypot(cx - mx, cy - my) / 150);
          const fresh = Math.max(0, 1 - (now - flipped[i]) / 520);
          const f = found.get(i);
          if (f) {
            // found: the cell goes red, as it does in the grids below
            const age = (now - f.t0) / 2600;
            ctx.globalAlpha = age < 0.85 ? 1 : Math.max(0, (1 - age) / 0.15);
            box(x, y);
            ctx.fillStyle = c.red;
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.fillText(String(bits[i]), cx, cy + 0.5);
            ctx.globalAlpha = 1;
            continue;
          }
          box(x, y);
          ctx.strokeStyle = c.cell;
          ctx.globalAlpha = 0.9;
          ctx.stroke();
          const lit = Math.max(near, fresh);
          ctx.fillStyle = lit > 0.05 ? c.ink : c.digit;
          ctx.globalAlpha = lit > 0.05 ? 0.35 + 0.65 * lit : 1;
          ctx.fillText(String(bits[i]), cx, cy + 0.5);
          ctx.globalAlpha = 1;
        }
      }

      // the marker ring going round each find
      ctx.strokeStyle = c.red;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const f of finds) {
        const age = (now - f.t0) / 2600;
        const drawn = Math.min(1, (now - f.t0) / 420);
        const n = Math.max(2, Math.floor(f.ring.length * drawn));
        ctx.globalAlpha = age < 0.85 ? 1 : Math.max(0, (1 - age) / 0.15);
        ctx.beginPath();
        ctx.moveTo(f.ring[0][0], f.ring[0][1]);
        for (let k = 1; k < n; k++) ctx.lineTo(f.ring[k][0], f.ring[k][1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const addFind = (now: number, nearPointer: boolean) => {
      for (let tries = 0; tries < 10; tries++) {
        const col = nearPointer ? Math.floor((mx + (Math.random() - 0.5) * 140) / PITCH) : Math.floor(Math.random() * cols);
        const row = nearPointer ? Math.floor((my + (Math.random() - 0.5) * 140) / PITCH) : Math.floor(Math.random() * rows);
        if (col < 1 || row < 1 || col >= cols - 1 || row >= rows - 1) continue;
        if (finds.some((f) => Math.abs(f.col - col) < 3 && Math.abs(f.row - row) < 3)) continue;
        const [x, y] = cellRect(col, row);
        finds.push({ col, row, t0: now, ring: markerRing(x + CELL / 2, y + CELL / 2, CELL * 0.86) });
        return;
      }
    };

    const tick = (now: number) => {
      // a handful of cells change their mind each frame
      for (let k = 0; k < 2; k++) {
        const i = Math.floor(Math.random() * bits.length);
        bits[i] ^= 1;
        flipped[i] = now;
      }
      finds = finds.filter((f) => now - f.t0 < 2600);
      if (now - lastFind > 900 && finds.length < 5) {
        lastFind = now;
        addFind(now, false);
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!onScreen || document.hidden || now - lastFrame < 32) return;
      lastFrame = now;
      tick(now);
      draw(now);
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      if (Math.random() < 0.05 && finds.length < 7) addFind(performance.now(), true);
    };
    const onLeave = () => {
      mx = -9999;
      my = -9999;
    };
    const onScheme = () => {
      readTheme();
      if (reduce) draw(0);
    };

    readTheme();
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(0);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
    });
    io.observe(canvas);
    scheme.addEventListener("change", onScheme);
    // the mono face may land after first paint; pick it up once it has
    document.fonts?.ready.then(readTheme).catch(() => {});

    if (reduce) {
      draw(0);
    } else {
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerleave", onLeave);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      scheme.removeEventListener("change", onScheme);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [seed]);

  return <canvas ref={ref} className="about-bitfield" aria-hidden="true" />;
}
