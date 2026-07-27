/**
 * The one chevron. Every expander on the site used the text glyph "⌄", whose
 * ink sits well above the centre of its em box — so `rotate(180deg)`, which
 * pivots around the box, swung it sideways instead of flipping it in place.
 * This path is centred in its viewBox (x 4–12, y 6–10 around 8,8), so it turns
 * on its own axis and lines up with the text beside it.
 */
export function Chevron({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `chev ${className}` : "chev"}
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 6.4 8 10 12 6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
