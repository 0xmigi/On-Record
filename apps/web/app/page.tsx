import Link from "next/link";
import { Mark } from "@/components/Mark";
import { ProgramRow } from "@/components/ProgramRow";
import { ClusterGroup } from "@/components/ClusterGroup";
import { SectionHeader } from "@/components/SectionHeader";
import {
  fetchFunnel,
  fetchRadar,
  isRadarType,
  isWindow,
  type ApiProgram,
  type RadarType,
  type RadarWindow,
} from "@/lib/api";
import { groupNum } from "@/lib/format";

const STREAM_FILTERS: { label: string; value: RadarType }[] = [
  { label: "NEW DEPLOYS", value: "deploy" },
  { label: "UPGRADES", value: "upgrade" },
];

const WINDOW_FILTERS: { label: string; value: RadarWindow }[] = [
  { label: "TODAY", value: "today" },
  { label: "THIS WEEK", value: "week" },
  { label: "ALL", value: "all" },
];

function radarHref(type: RadarType, window: RadarWindow, cursor?: string): string {
  const params = new URLSearchParams();
  if (type !== "deploy") params.set("type", type);
  if (window !== "today") params.set("window", window);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

/** Header strip: today's split of new programs vs upgrades, and how many of
 *  those "new programs" are actually throwaway bots redeploying themselves. */
function FunnelStrip({
  deploys,
  upgrades,
  bots,
}: {
  deploys: number | null;
  upgrades: number | null;
  bots: number | null;
}) {
  return (
    <Link className="funnel-strip" href="/funnel" aria-label="Open the funnel">
      <span className="funnel-cell">
        <span className="funnel-num funnel-num-accent">{groupNum(deploys)}</span>
        <span className="funnel-lbl">new programs today</span>
        {bots && deploys ? (
          <span className="funnel-bots">
            {groupNum(bots)} are throwaway bots
          </span>
        ) : null}
      </span>
      <span className="funnel-arrow" aria-hidden="true">
        ·
      </span>
      <span className="funnel-cell">
        <span className="funnel-num">{groupNum(upgrades)}</span>
        <span className="funnel-lbl">upgrades</span>
      </span>
      <span className="funnel-arrow" aria-hidden="true">
        →
      </span>
      <span className="funnel-cell funnel-cell-end">
        <span className="funnel-lbl">see the funnel</span>
      </span>
    </Link>
  );
}

export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; window?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const type: RadarType = isRadarType(sp.type) ? sp.type : "deploy";
  const window: RadarWindow = isWindow(sp.window) ? sp.window : "today";
  const cursor = sp.cursor;

  // Bot clusters (byte-clone redeploys) are hidden from the novel feed, but we
  // fold them back in as one collapsed entry per cluster on the first page —
  // the most recent redeploy shown, the rest stacked underneath. Only on the
  // new-deploys stream, page one (clones aren't cursor-paged).
  const showClusters = type === "deploy" && !cursor;
  const [page, clonePage, funnel] = await Promise.all([
    fetchRadar({ type, window, cursor }),
    showClusters
      ? fetchRadar({ type, window, band: "clone", limit: 100 })
      : Promise.resolve({ items: [] as ApiProgram[], nextCursor: null }),
    fetchFunnel(),
  ]);

  const ts = (p: ApiProgram) => (p.deployedAt ? Date.parse(p.deployedAt) : 0);

  const byBucket = new Map<string, ApiProgram[]>();
  for (const c of clonePage.items) {
    const k = c.bucketId ?? c.id;
    const arr = byBucket.get(k);
    if (arr) arr.push(c);
    else byBucket.set(k, [c]);
  }

  type FeedItem =
    | { kind: "program"; key: string; t: number; program: ApiProgram }
    | { kind: "cluster"; key: string; t: number; rep: ApiProgram; members: ApiProgram[] };

  const feed: FeedItem[] = [
    ...page.items.map(
      (p): FeedItem => ({ kind: "program", key: p.id, t: ts(p), program: p }),
    ),
    ...[...byBucket.values()].map((members): FeedItem => {
      members.sort((a, b) => ts(b) - ts(a));
      const rep = members[0];
      return {
        kind: "cluster",
        key: rep.bucketId ?? rep.id,
        t: ts(rep),
        rep,
        members: members.slice(1),
      };
    }),
  ].sort((a, b) => b.t - a.t);

  return (
    <>
      <FunnelStrip
        deploys={funnel?.deploys ?? null}
        upgrades={funnel?.upgrades ?? null}
        bots={funnel?.churn?.redeploys ?? null}
      />

      <div className="radar-controls">
        <nav className="filter-row" aria-label="New deploys or upgrades">
          {STREAM_FILTERS.map((f) => (
            <Link
              key={f.value}
              className="filter-link"
              href={radarHref(f.value, window)}
              aria-current={type === f.value ? "page" : undefined}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <nav className="filter-row filter-row-end" aria-label="Filter by window">
          {WINDOW_FILTERS.map((f) => (
            <Link
              key={f.value}
              className="filter-link"
              href={radarHref(type, f.value)}
              aria-current={window === f.value ? "page" : undefined}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      </div>

      <SectionHeader
        title={
          type === "deploy"
            ? "New deployments — trust from zero"
            : "Upgrades — existing programs changed"
        }
        info={
          type === "deploy"
            ? "Brand-new program ids, deployed in this window. A new id means trust starts from scratch. Ranked by signal; open one for its full on-chain record."
            : "Existing programs whose code changed in this window. Trust already exists — what matters is the magnitude of what was changed."
        }
      />

      {feed.length === 0 ? (
        <div className="empty-state">
          <Mark size={22} />
          <p className="empty-title">The radar is quiet</p>
          <p className="empty-body">
            {type === "deploy"
              ? "No new programs in this window yet. Fresh deploys land here as the loader sees them."
              : "No upgrades in this window yet."}
          </p>
        </div>
      ) : (
        <ol className="radar-list">
          {feed.map((item) => (
            <li key={item.key}>
              {item.kind === "cluster" ? (
                <ClusterGroup rep={item.rep} members={item.members} />
              ) : (
                <ProgramRow program={item.program} />
              )}
            </li>
          ))}
        </ol>
      )}

      {page.nextCursor ? (
        <nav className="pager" aria-label="Pagination">
          <Link
            className="older-link"
            href={radarHref(type, window, page.nextCursor)}
          >
            More →
          </Link>
        </nav>
      ) : null}
    </>
  );
}
