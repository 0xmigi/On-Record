import type { ReactNode } from "react";

/**
 * A collapsed "What's X?" explainer that lives at the bottom of the section it
 * defines — not pooled at the end of the page, so each concept's definition
 * sits next to the data it explains. Server-rendered <details>, no JS.
 */
export function SectionExplainer({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="explainer explainer-section">
      <summary className="explainer-summary">
        <span>{title}</span>
        <span className="explainer-chev" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="explainer-body">{children}</div>
    </details>
  );
}
