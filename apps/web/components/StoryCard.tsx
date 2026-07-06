import Link from "next/link";
import {
  receiptHref,
  STORY_TYPE_LABELS,
  type ApiStory,
  type Receipt,
  type StoryInference,
} from "@/lib/api";
import { relativeTime, shortUrl, truncateAddress } from "@/lib/format";

function receiptLabel(receipt: Receipt): string {
  return receipt.kind === "repo" ? shortUrl(receipt.ref) : truncateAddress(receipt.ref);
}

export function ReceiptLink({ receipt }: { receipt: Receipt }) {
  return (
    <a
      className="receipt-link"
      href={receiptHref(receipt)}
      target="_blank"
      rel="noopener noreferrer"
      title={receipt.ref}
    >
      {receiptLabel(receipt)}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

const CONFIDENCE_LABELS: Record<StoryInference["confidence"], string> = {
  low: "LOW",
  med: "MED",
  high: "HIGH",
};

/**
 * The inference register. Visually offset from fact — dashed border,
 * gray ground, italic — and always labeled with its confidence.
 */
export function OurRead({ inference }: { inference: StoryInference }) {
  return (
    <aside className="our-read">
      <p className="our-read-label">
        OUR READ
        <span className={`conf-chip conf-${inference.confidence}`}>
          {CONFIDENCE_LABELS[inference.confidence]} CONFIDENCE
        </span>
      </p>
      <p className="our-read-text">{inference.text}</p>
    </aside>
  );
}

/**
 * One story on the record. Facts up top in the fact register;
 * proof folded into a <details>; inference clearly quarantined below.
 * Copy-wave stories get a stacked-paper treatment.
 */
export function StoryCard({ story }: { story: ApiStory }) {
  const card = (
    <article className="story-card">
      <div className="story-meta">
        <span className={`type-tag type-${story.type}`}>
          {STORY_TYPE_LABELS[story.type]}
        </span>
        {story.pinned ? (
          <span className="pin-flag" title="Held at the top of the record">
            PINNED
          </span>
        ) : null}
        <time className="story-time" dateTime={story.publishedAt}>
          {relativeTime(story.publishedAt)}
        </time>
      </div>

      <h3 className="story-headline">
        <Link href={`/story/${story.id}`}>{story.headline}</Link>
      </h3>

      <p className="story-body">{story.body}</p>

      {story.subjects.length > 0 ? (
        <p className="subject-links">
          {story.subjects.map((subject) => (
            <Link
              className="subject-link"
              key={subject.id}
              href={`/s/${subject.id}`}
              title={subject.id}
            >
              {subject.name ?? truncateAddress(subject.id)}
            </Link>
          ))}
        </p>
      ) : null}

      {story.facts.length > 0 ? (
        <details className="proof">
          <summary>PROOF ({story.facts.length})</summary>
          <ul className="proof-list">
            {story.facts.map((fact, i) => (
              <li key={i}>
                <span className="proof-text">{fact.text}</span>{" "}
                <ReceiptLink receipt={fact.receipt} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {story.inference ? <OurRead inference={story.inference} /> : null}
    </article>
  );

  if (story.type === "copy_wave") {
    return <div className="copy-stack">{card}</div>;
  }
  return card;
}
