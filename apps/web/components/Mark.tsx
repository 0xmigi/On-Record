/** The ⊙ record mark — a circle around a solid center, in Helius orange-red. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className="mark"
    >
      <circle cx="16" cy="16" r="12.5" fill="none" stroke="#E8432C" strokeWidth="4" />
      <circle cx="16" cy="16" r="5" fill="#E8432C" />
    </svg>
  );
}
