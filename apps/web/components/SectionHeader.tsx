/**
 * Uppercase, letter-spaced section header with a small circled-i
 * affordance explaining what the section is.
 */
export function SectionHeader({ title, info }: { title: string; info: string }) {
  return (
    <h2 className="section-header">
      <span>{title}</span>
      <span className="info-dot" data-tip={info} tabIndex={0} aria-label={info} role="note">
        i
      </span>
    </h2>
  );
}
