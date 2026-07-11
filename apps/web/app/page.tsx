import Link from "next/link";
import { Mark } from "@/components/Mark";
import { ProgramRow } from "@/components/ProgramRow";
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
import { botKind, BOT_LABEL, deriveLifecycle } from "@/lib/lifecycle";
import { groupNum, relativeTime, truncateAddress } from "@/lib/format";

type View = "novel" | "variant" | "recycled";

const STREAM_FILTERS: { label: string; value: RadarType }[] = [
  { label: "NEW DEPLOYS", value: "deploy" },
  { label: "UPGRADES", value: "upgrade" },
];

const WINDOW_FILTERS: { label: string; value: RadarWindow }[] = [
  { label: "LAST 24H", value: "today" },
  { label: "THIS WEEK", value: "week" },
  { label: "THIS MONTH", value: "month" },
  { label: "ALL", value: "all" },
];

const WINDOW_WORD: Record<RadarWindow, string> = {
  today: "last 24h",
  week: "this week",
  month: "this month",
  all: "all time",
};

// The header total (funnel) speaks in hour keys; keep it on the same window as
// the tier counts so the big number and the novel/variant/recycled split agree.
const FUNNEL_WINDOW: Record<RadarWindow, string> = {
  today: "24h",
  week: "7d",
  month: "30d",
  all: "all",
};

function radarHref(type: RadarType, window: RadarWindow): string {
  const params = new URLSearchParams();
  if (type !== "deploy") params.set("type", type);
  if (window !== "today") params.set("window", window);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

function viewHref(view: View | undefined, window: RadarWindow): string {
  const params = new URLSearchParams();
  if (window !== "today") params.set("window", window);
  if (view) params.set("view", view);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

/** The spectrum header — the daily total, then novelty tiers that double as
 *  filters (novel · variant · recycled), then a link into the funnel/stats. */
function SpectrumBar({
  deploys,
  upgrades,
  counts,
  view,
  window,
}: {
  deploys: number | null;
  upgrades: number | null;
  counts: { novel: number; variant: number; recycled: number } | null;
  view: View | undefined;
  window: RadarWindow;
}) {
  const Tier = ({ k, n }: { k: View; n: number }) => {
    const active = view === k;
    return (
      <Link
        className={`tier tier-${k}${active ? " active" : ""}`}
        href={viewHref(active ? undefined : k, window)}
        scroll={false}
      >
        <span className="tier-n">{groupNum(n)}</span>
        <span className="tier-k">{k}</span>
      </Link>
    );
  };
  return (
    <div className="spectrum-bar">
      <div className="spectrum-total">
        <span className="spectrum-num">{groupNum(deploys)}</span>
        <span className="spectrum-lbl">new programs {WINDOW_WORD[window]}</span>
      </div>
      {counts ? (
        <div className="spectrum-tiers" role="group" aria-label="Filter by novelty">
          <Tier k="novel" n={counts.novel} />
          <span className="spectrum-sep" aria-hidden="true">
            ·
          </span>
          <Tier k="variant" n={counts.variant} />
          <span className="spectrum-sep" aria-hidden="true">
            ·
          </span>
          <Tier k="recycled" n={counts.recycled} />
        </div>
      ) : null}
      <Link className="spectrum-funnel" href="/funnel">
        {groupNum(upgrades)} upgrades · stats →
      </Link>
    </div>
  );
}

/** One compact row in the recycled section: the newest redeploy of a byte-clone
 *  cluster, its confidence label, and how many share the code. */
function RecycledRow({ rep, count }: { rep: ApiProgram; count: number }) {
  const kind = botKind(rep) ?? "recycled";
  const t = rep.momentum?.txns24h ?? rep.earlySigners ?? null;
  return (
    <Link href={`/p/${rep.id}`} className="recycled-row">
      <span className={`recycled-kind rk-${kind}`}>{BOT_LABEL[kind]}</span>
      <span className="recycled-name">{rep.name ?? truncateAddress(rep.id)}</span>
      <span className="recycled-x">×{count} {count === 1 ? "seen" : "today"}</span>
      {t ? (
        <span className="recycled-txns">
          {t.toLocaleString("en-US")}
          {t % 1000 === 0 ? "+" : ""} txns
        </span>
      ) : null}
      <span className="recycled-when">newest {relativeTime(rep.deployedAt)}</span>
    </Link>
  );
}

function RecycledSection({
  clusters,
  count,
  open,
}: {
  clusters: { key: string; rep: ApiProgram; size: number }[];
  count: number;
  open: boolean;
}) {
  if (!clusters.length) return null;
  return (
    <details className="recycled-section" open={open}>
      <summary className="recycled-summary">
        <span className="recycled-chev" aria-hidden="true">
          ⌄
        </span>
        <span>
          <strong>Recycled</strong> — {groupNum(count)} byte-clone redeploy
          {count === 1 ? "" : "s"} across {clusters.length} program
          {clusters.length === 1 ? "" : "s"}. Same code, fresh ids — not new.
        </span>
      </summary>
      <div className="recycled-list">
        {clusters.map((c) => (
          <RecycledRow key={c.key} rep={c.rep} count={c.size} />
        ))}
      </div>
    </details>
  );
}

/** The graveyard: programs whose ProgramData vanished (rent reclaimed). They
 *  never occupy the main tiers — they pile up here, labelled by lifespan. */
function ClosedSection({ items }: { items: ApiProgram[] }) {
  if (!items.length) return null;
  return (
    <details className="recycled-section closed-section">
      <summary className="recycled-summary">
        <span className="recycled-chev" aria-hidden="true">
          ⌄
        </span>
        <span>
          <strong>Closed</strong> — {groupNum(items.length)} program
          {items.length === 1 ? "" : "s"} deployed and already gone (rent
          reclaimed). The churn tail, kept out of the feed.
        </span>
      </summary>
      <div className="recycled-list">
        {items.slice(0, 30).map((p) => {
          const life = deriveLifecycle(p);
          const kind = botKind(p);
          return (
            <Link href={`/p/${p.id}`} className="recycled-row" key={p.id}>
              <span className="recycled-kind rk-closed">
                closed{life.lifespanLabel ? ` within ${life.lifespanLabel}` : ""}
              </span>
              <span className="recycled-name">{p.name ?? truncateAddress(p.id)}</span>
              {kind ? <span className="recycled-x">{BOT_LABEL[kind]}</span> : null}
              <span className="recycled-when">deployed {relativeTime(p.deployedAt)}</span>
            </Link>
          );
        })}
      </div>
    </details>
  );
}

export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; window?: string; view?: string }>;
}) {
  const sp = await searchParams;
  const type: RadarType = isRadarType(sp.type) ? sp.type : "deploy";
  const window: RadarWindow = isWindow(sp.window) ? sp.window : "today";
  const isDeploy = type === "deploy";
  const view: View | undefined =
    isDeploy && (sp.view === "novel" || sp.view === "variant" || sp.view === "recycled")
      ? sp.view
      : undefined;

  const EMPTY = { items: [] as ApiProgram[], nextCursor: null };
  const [novelPage, variantPage, clonePage, closedPages, upgradePage, funnel] = await Promise.all([
    isDeploy ? fetchRadar({ type, window, band: "novel", limit: 100 }) : Promise.resolve(EMPTY),
    isDeploy ? fetchRadar({ type, window, band: "variant", limit: 100 }) : Promise.resolve(EMPTY),
    isDeploy ? fetchRadar({ type, window, band: "clone", limit: 100 }) : Promise.resolve(EMPTY),
    // the graveyard: closed programs across all bands (rent reclaimed)
    isDeploy
      ? Promise.all(
          (["novel", "variant", "clone"] as const).map((band) =>
            fetchRadar({ type, window, band, closed: "only", limit: 100 }),
          ),
        )
      : Promise.resolve([]),
    !isDeploy ? fetchRadar({ type, window, limit: 50 }) : Promise.resolve(EMPTY),
    fetchFunnel(FUNNEL_WINDOW[window]),
  ]);

  const ts = (p: ApiProgram) => (p.deployedAt ? Date.parse(p.deployedAt) : 0);
  const recency = (a: ApiProgram, b: ApiProgram) => ts(b) - ts(a);
  // interest ordering (the API's default sort — noveltyScore carries the
  // interest v0.1 blend); recency breaks ties so fresh unscored rows behave
  const interest = (a: ApiProgram, b: ApiProgram) =>
    (b.noveltyScore ?? 0) - (a.noveltyScore ?? 0) || recency(a, b);

  const closedItems = closedPages
    .flatMap((p) => p.items)
    .sort(recency);

  /** Collapse rows sharing a copy-bucket into one card (the near-copy churn:
   *  same code family deployed ×N under fresh ids). The FIRST sighting of the
   *  family in the window holds its spot — later duplicates stack behind it
   *  (the ×N chip carries the count) and never re-float the family to the
   *  top. Families then rank on that first entry's own interest. */
  const collapseBuckets = (items: ApiProgram[]): ApiProgram[] => {
    const families = new Map<string, ApiProgram>();
    for (const p of items) {
      const k = p.bucketId ?? p.id;
      const cur = families.get(k);
      if (!cur || ts(p) < ts(cur)) families.set(k, p);
    }
    return [...families.values()].sort(interest);
  };

  // recycled = byte-clones, grouped into one entry per cluster (newest is rep)
  const byBucket = new Map<string, ApiProgram[]>();
  for (const c of clonePage.items) {
    const k = c.bucketId ?? c.id;
    const arr = byBucket.get(k);
    if (arr) arr.push(c);
    else byBucket.set(k, [c]);
  }
  const clusters = [...byBucket.values()]
    .map((ms) => {
      ms.sort(recency);
      return { key: ms[0].bucketId ?? ms[0].id, rep: ms[0], size: ms.length, t: ts(ms[0]) };
    })
    .sort((a, b) => b.t - a.t);

  const counts = isDeploy
    ? {
        novel: novelPage.items.length,
        variant: variantPage.items.length,
        recycled: clonePage.items.length,
      }
    : null;

  // main list depends on the active tier; default (notable) = novel + variants,
  // interest-ordered, near-copy families collapsed to one card each
  const notable = collapseBuckets(
    [...novelPage.items, ...variantPage.items].sort(interest),
  );
  const mainItems = !isDeploy
    ? upgradePage.items
    : view === "novel"
      ? novelPage.items
      : view === "variant"
        ? collapseBuckets(variantPage.items)
        : view === "recycled"
          ? []
          : notable;

  const showRecycled = isDeploy && (view === undefined || view === "recycled");

  const header = !isDeploy
    ? { title: "Upgrades — existing programs changed", info: "Existing programs whose code changed in this window. Trust already exists — what matters is the magnitude of what was changed." }
    : view === "novel"
      ? { title: "Novel — no known relative", info: "Bytecode with no match in the corpus. The genuinely new programs — the core signal." }
      : view === "variant"
        ? { title: "Variants & forks", info: "Loosely similar to known code — a fork or derivative, not a byte-for-byte copy. Often a real protocol variant worth a look." }
        : view === "recycled"
          ? { title: "Recycled — byte-clones redeployed", info: "Identical bytecode already on record, redeployed under fresh ids. Not new code. Some are bots (sniper / throwaway), some are factories or dev redeploys — labelled by what the signature supports." }
          : { title: "New & notable — novel code and forks", info: "Genuinely new programs and meaningful forks, newest first. Byte-clone redeploys are collapsed into the Recycled section below." };

  return (
    <>
      <SpectrumBar
        deploys={funnel?.deploys ?? null}
        upgrades={funnel?.upgrades ?? null}
        counts={counts}
        view={view}
        window={window}
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

      <SectionHeader title={header.title} info={header.info} />

      {mainItems.length === 0 && view !== "recycled" ? (
        <div className="empty-state">
          <Mark size={22} />
          <p className="empty-title">The radar is quiet</p>
          <p className="empty-body">
            {isDeploy
              ? "Nothing in this slice yet. Fresh deploys land here as the loader sees them."
              : "No upgrades in this window yet."}
          </p>
        </div>
      ) : (
        <ol className="radar-list">
          {mainItems.map((program) => (
            <li key={program.id}>
              <ProgramRow program={program} />
            </li>
          ))}
        </ol>
      )}

      {showRecycled ? (
        <RecycledSection
          clusters={clusters}
          count={clonePage.items.length}
          open={view === "recycled"}
        />
      ) : null}

      {isDeploy ? <ClosedSection items={closedItems} /> : null}
    </>
  );
}
