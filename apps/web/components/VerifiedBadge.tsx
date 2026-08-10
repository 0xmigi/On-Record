/** Verified-build badge — the scalloped check that reads as "verified" at a
 *  glance, sized to sit inline beside a program name.
 *
 *  Green rather than blue on purpose: blue reads as a social-platform identity
 *  check, and this claims something narrower and more mechanical — the deployed
 *  bytecode reproduces from public source. The scallop is our own geometry.
 *
 *  Kept as one component so the radar row and the dossier header cannot drift
 *  apart on what "verified" looks like. */
export function VerifiedBadge({
  size = 14,
  title = "Verified build — the on-chain bytecode reproduces from public source",
}: {
  size?: number;
  title?: string;
}) {
  return (
    <svg
      className="verified-badge"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Verified build"
      focusable="false"
    >
      <title>{title}</title>
      <path
        className="verified-badge-disc"
        d="M9.33 2.77Q12.05 -1.57 14.77 2.77Q19.41 0.59 19.36 5.72Q24.44 6.39 21.62 10.67Q25.53 13.99 20.84 16.07Q22.34 20.97 17.28 20.18Q15.89 25.12 12.05 21.72Q8.21 25.12 6.82 20.18Q1.75 20.97 3.25 16.07Q-1.43 13.99 2.48 10.67Q-0.34 6.39 4.74 5.72Q4.68 0.59 9.33 2.77Z"
      />
      <path
        className="verified-badge-check"
        d="M7.4 12.3l3.1 3.1 6.1-6.4"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
