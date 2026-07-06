import Link from "next/link";
import { Mark } from "@/components/Mark";
import { SectionHeader } from "@/components/SectionHeader";
import { StatStrip } from "@/components/StatStrip";
import { StoryCard } from "@/components/StoryCard";
import {
  fetchStats,
  fetchStories,
  isStoryType,
  type StoryType,
} from "@/lib/api";

const FILTERS: { label: string; value: StoryType | null }[] = [
  { label: "ALL", value: null },
  { label: "UPDATE", value: "update" },
  { label: "LAUNCH", value: "launch" },
  { label: "RADAR", value: "radar" },
  { label: "NOW LIVE", value: "became_real" },
  { label: "CONTROL", value: "control_change" },
  { label: "COPIES", value: "copy_wave" },
  { label: "ON RECORD", value: "corroboration" },
];

function feedHref(type: StoryType | null, cursor?: string): string {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const type = isStoryType(sp.type) ? sp.type : null;
  const cursor = sp.cursor;

  const [page, stats] = await Promise.all([
    fetchStories({ type: type ?? undefined, cursor }),
    fetchStats(),
  ]);

  // Pinned stories float to the top; within each group, API order
  // (newest first) is preserved.
  const stories = [...page.items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned)
  );

  return (
    <>
      <StatStrip stats={stats} />

      <nav className="filter-row" aria-label="Filter stories by type">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            className="filter-link"
            href={feedHref(filter.value)}
            aria-current={type === filter.value ? "page" : undefined}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      <SectionHeader
        title="Recent stories"
        info="Every story here is backed by something that actually happened on chain. Open PROOF to see the receipts."
      />

      {stories.length === 0 ? (
        <div className="empty-state">
          <Mark size={22} />
          <p className="empty-title">The record is warming up</p>
          <p className="empty-body">
            Stories appear as things actually happen on chain.
            {type ? " Nothing under this filter yet — try ALL." : ""}
          </p>
        </div>
      ) : (
        <ol className="story-list">
          {stories.map((story) => (
            <li key={story.id}>
              <StoryCard story={story} />
            </li>
          ))}
        </ol>
      )}

      {page.nextCursor ? (
        <nav className="pager" aria-label="Pagination">
          <Link className="older-link" href={feedHref(type, page.nextCursor)}>
            Older →
          </Link>
        </nav>
      ) : null}
    </>
  );
}
