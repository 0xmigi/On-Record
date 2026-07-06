import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SectionHeader } from "@/components/SectionHeader";
import { StoryCard } from "@/components/StoryCard";
import { fetchSubject, type ApiSubject } from "@/lib/api";
import { compactUsd, shortUrl, truncateAddress } from "@/lib/format";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subject: string }>;
}): Promise<Metadata> {
  const { subject } = await params;
  const data = await fetchSubject(subject);
  return { title: data ? (data.name ?? truncateAddress(data.id)) : "Subject" };
}

function controlText(authorityClass: ApiSubject["authorityClass"]): string {
  switch (authorityClass) {
    case "none":
      return "Frozen — no one can change it";
    case "squads":
      return "Controlled by a team key";
    case "program":
      return "Controlled by governance";
    case "hot_wallet":
      return "Controlled by a single key";
    default:
      return "Not established yet";
  }
}

export default async function SubjectPage({
  params,
}: {
  params: Promise<{ subject: string }>;
}) {
  const { subject } = await params;
  const data = await fetchSubject(subject);
  if (!data) notFound();

  const displayName = data.name ?? truncateAddress(data.id);

  return (
    <article>
      <Link className="back-link" href="/">
        ← Back to the feed
      </Link>

      <h1 className="subject-title">
        {displayName}
        {data.network === "devnet" ? (
          <span className="net-chip">TEST NETWORK</span>
        ) : null}
      </h1>

      <SectionHeader
        title="Current facts"
        info="What we can verify about this app right now, from the chain itself."
      />

      <div className="facts-panel">
        <div className="fact-row">
          <span className="fact-label">Who can change it</span>
          <span className="fact-value">{controlText(data.authorityClass)}</span>
        </div>

        <div className="fact-row">
          <span className="fact-label">Is the code public</span>
          <span className="fact-value">
            {data.verified ? (
              <>
                Code is public and matches
                {data.repoUrl ? (
                  <a
                    className="receipt-link"
                    href={data.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={data.repoUrl}
                  >
                    {shortUrl(data.repoUrl)}
                    <span aria-hidden="true"> ↗</span>
                  </a>
                ) : null}
              </>
            ) : (
              "Code is not public"
            )}
          </span>
        </div>

        <div className="fact-row">
          <span className="fact-label">Value held</span>
          <span className="fact-value">
            {data.tvl !== null ? `${compactUsd(data.tvl)} held in it` : "Not tracked yet"}
          </span>
        </div>

        <div className="fact-row">
          <span className="fact-label">On the record as</span>
          <span className="fact-value">
            <a
              className="receipt-link"
              href={`https://orb.helius.dev/address/${data.id}`}
              target="_blank"
              rel="noopener noreferrer"
              title={data.id}
            >
              {truncateAddress(data.id)}
              <span aria-hidden="true"> ↗</span>
            </a>
          </span>
        </div>
      </div>

      <SectionHeader
        title="Story history"
        info="Everything we've put on the record about this app, newest first."
      />

      {data.stories.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">Nothing on the record yet</p>
          <p className="empty-body">
            When this app ships something, the story lands here.
          </p>
        </div>
      ) : (
        <ol className="story-list">
          {data.stories.map((story) => (
            <li key={story.id}>
              <StoryCard story={story} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
