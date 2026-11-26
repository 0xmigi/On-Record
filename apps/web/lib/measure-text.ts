// Text width in the browser, for placing labels on charts before they render.
// A canvas measures with the page's own fonts; on the server it falls back to
// a rough per-character width so the first paint is close.

let ctx: CanvasRenderingContext2D | null = null;

export function textWidth(text: string, font: string): number {
  if (typeof document === "undefined") return text.length * 7;
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** a CSS font shorthand using one of the page's font variables */
export function pageFont(el: Element | null, variable: "--font-sans" | "--font-mono", sizeWeight: string): string {
  const family =
    (el && getComputedStyle(el).getPropertyValue(variable).trim()) ||
    (variable === "--font-mono" ? "ui-monospace, monospace" : "system-ui, sans-serif");
  return `${sizeWeight} ${family}`;
}
