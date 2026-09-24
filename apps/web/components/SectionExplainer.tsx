import type { ReactNode } from "react";
import { Chevron } from "@/components/Chevron";

/**
 * A collapsed "What's X?" explainer that lives at the bottom of the section it
 * defines — not pooled at the end of the page, so each concept's definition
 * sits next to the data it explains. Server-rendered <details>, no JS.
 *
 * Pass `summary` when the data is a single line: it becomes the clickable
 * header itself, so the fact and its explanation are one box, not two.
 */
export function SectionExplainer({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="explainer explainer-section">
      <summary className="explainer-summary">
        {summary ?? <span>{title}</span>}
        <Chevron className="explainer-chev" />
      </summary>
      <div className="explainer-body">{children}</div>
    </details>
  );
}
