import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SectionHeader } from "@/components/SectionHeader";
import { OurRead, ReceiptLink } from "@/components/StoryCard";
import {
  fetchStory,
  STORY_TYPE_LABELS,
  type ApiRawEvent,
} from "@/lib/api";
import { relativeTime, truncateAddress, utcStamp } from "@/lib/format";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const story = await fetchStory(id);
  return { title: story ? story.headline : "Story" };
}

/** What happened, in plain words — no chain jargon outside the mono cells. */
function eventPhrase(event: ApiRawEvent): string {
  switch (event.type) {
    case "deploy":
      return "Went live";
    case "upgrade":
      return "Shipped an update";
    case "set_authority":
      return "Control changed hands";
    case "close":
      return "Taken down";
  }
}

export default async function StoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const story = await fetchStory(id);
  if (!story) notFound();

  return (
    <article>
      <Link className="back-link" href="/">
        ← Back to the feed
      </Link>

      <div className="story-meta" style={{ marginTop: 18 }}>
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

      <h1 className="story-page-headline">{story.headline}</h1>
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
        <>
          <SectionHeader
            title={`Proof (${story.facts.length})`}
            info="Each fact links to its receipt — the on-chain transaction, account, or public code that proves it."
          />
          <ul className="proof-list">
            {story.facts.map((fact, i) => (
              <li key={i}>
                <span className="proof-text">{fact.text}</span>{" "}
                <ReceiptLink receipt={fact.receipt} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {story.inference ? <OurRead inference={story.inference} /> : null}

      <SectionHeader
        title="The record"
        info="The raw technical trail behind this story. Identifiers here are exact and verifiable on chain."
      />
      <p className="record-note">
        Every line below is something that happened on chain. Follow a
        signature to verify it yourself.
      </p>

      {story.events.length === 0 ? (
        <div className="empty-state">
          <p className="empty-body">No underlying entries attached to this story.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="record-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">What happened</th>
                <th scope="col">App</th>
                <th scope="col">Signature</th>
              </tr>
            </thead>
            <tbody>
              {story.events.map((event) => (
                <tr key={event.id}>
                  <td className="cell-dim">{utcStamp(event.blockTime)}</td>
                  <td className="plain">
                    {eventPhrase(event)}
                    {event.network === "devnet" ? (
                      <>
                        {" "}
                        <span className="net-chip">TEST NETWORK</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <a
                      className="receipt-link"
                      href={`https://orb.helius.dev/address/${event.programId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={event.programId}
                    >
                      {truncateAddress(event.programId)}
                    </a>
                  </td>
                  <td>
                    <a
                      className="receipt-link"
                      href={`https://orb.helius.dev/tx/${event.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={event.signature}
                    >
                      {truncateAddress(event.signature)}
                      <span aria-hidden="true"> ↗</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
