import Link from "next/link";
import { Mark } from "@/components/Mark";
import { ProgramRow } from "@/components/ProgramRow";
import { SectionHeader } from "@/components/SectionHeader";
import {
  fetchFunnel,
  fetchRadar,
  isRadarType,
  isWindow,
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

  const [page, funnel] = await Promise.all([
    fetchRadar({ type, window, cursor }),
    fetchFunnel(),
  ]);

  const programs = page.items;

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

      {programs.length === 0 ? (
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
          {programs.map((program) => (
            <li key={program.id}>
              <ProgramRow program={program} />
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
