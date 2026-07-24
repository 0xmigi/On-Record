import { cookies } from "next/headers";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { ProgramRow } from "@/components/ProgramRow";
import { RadarFilters } from "@/components/RadarFilters";
import { SectionHeader } from "@/components/SectionHeader";
import {
  fetchFunnel,
  fetchRadar,
  isRadarType,
  isWindow,
  type ApiProgram,
  type Network,
  type RadarType,
  type RadarWindow,
} from "@/lib/api";
import {
  buildRadarHref,
  hasActiveFacets,
  isView,
  matchesFacets,
  parseAuthority,
  parseCategory,
  parseFramework,
  parseSize,
  withPatch,
  type RadarParams,
  type View,
} from "@/lib/radar-url";
import { botKind, BOT_LABEL, deriveLifecycle } from "@/lib/lifecycle";
import { groupNum, relativeTime, truncateAddress } from "@/lib/format";

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

/** The spectrum header — the daily total, then novelty tiers that double as
 *  filters (novel · variant · recycled), then a link into the funnel/stats. */
function SpectrumBar({
  deploys,
  upgrades,
  counts,
  params,
}: {
  deploys: number | null;
  upgrades: number | null;
  counts: { novel: number; variant: number; recycled: number } | null;
  params: RadarParams;
}) {
  const view = params.view;
  const Tier = ({ k, n }: { k: View; n: number }) => {
    const active = view === k;
    return (
      <Link
        className={`tier tier-${k}${active ? " active" : ""}`}
        href={withPatch(params, { view: active ? undefined : k })}
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
        <span className="spectrum-lbl">new programs {WINDOW_WORD[params.window]}</span>
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
function RecycledRow({ rep, count, windowLabel }: { rep: ApiProgram; count: number; windowLabel: string }) {
  const kind = botKind(rep) ?? "recycled";
  const t = rep.momentum?.txns24h ?? rep.earlySigners ?? null;
  return (
    <Link href={`/p/${rep.id}`} className="recycled-row">
      <span className={`recycled-kind rk-${kind}`}>{BOT_LABEL[kind]}</span>
      <span className="recycled-name">{rep.name ?? truncateAddress(rep.id)}</span>
      <span className="recycled-x">×{count} {count === 1 ? "seen" : windowLabel}</span>
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

const WINDOW_LABEL: Record<RadarWindow, string> = {
  today: "today",
  week: "this week",
  month: "this month",
  all: "all time",
};

function RecycledSection({
  clusters,
  count,
  open,
  windowLabel,
}: {
  clusters: { key: string; rep: ApiProgram; size: number }[];
  count: number;
  open: boolean;
  windowLabel: string;
}) {
  if (!clusters.length) return null;
  return (
    <details className="recycled-section" open={open}>
      <summary className="recycled-summary">
        <span className="recycled-chev" aria-hidden="true">
          ⌄
        </span>
        <span
          title="Bots and factories redeploy the same binary under new addresses — each copy teaches nothing the original doesn't. One entry per code."
        >
          <strong>Recycled</strong> — {groupNum(count)} redeploy
          {count === 1 ? "" : "s"} not shown because the same bytecode is
          already on record.
        </span>
      </summary>
      <div className="recycled-list">
        {clusters.map((c) => (
          <RecycledRow key={c.key} rep={c.rep} count={c.size} windowLabel={windowLabel} />
        ))}
      </div>
    </details>
  );
}

/** The graveyard: programs whose ProgramData vanished (rent reclaimed). They
 *  never occupy the main tiers — they pile up here, one entry per code
 *  family, anchored on the family's oldest dead member. */
function ClosedSection({
  groups,
  total,
}: {
  groups: { rep: ApiProgram; size: number }[];
  total: number;
}) {
  if (!groups.length) return null;
  return (
    <details className="recycled-section closed-section">
      <summary className="recycled-summary">
        <span className="recycled-chev" aria-hidden="true">
          ⌄
        </span>
        <span
          title="Closing deallocates the code and refunds the rent — deployed-then-closed same day means disposable by design, usually a bot cashing out. The code can never run again."
        >
          <strong>Closed</strong> — {groupNum(total)} program
          {total === 1 ? "" : "s"} not shown because their deployer deleted
          them and the code can never run again.
        </span>
      </summary>
      <div className="recycled-list">
        {groups.slice(0, 30).map(({ rep, size }) => {
          const life = deriveLifecycle(rep);
          const kind = botKind(rep);
          return (
            <Link href={`/p/${rep.id}`} className="recycled-row" key={rep.id}>
              <span className="recycled-kind rk-closed">
                closed{life.lifespanLabel ? ` within ${life.lifespanLabel}` : ""}
              </span>
              <span className="recycled-name">{rep.name ?? truncateAddress(rep.id)}</span>
              {size > 1 ? <span className="recycled-x">×{size} of this code</span> : null}
              {kind ? <span className="recycled-x">{BOT_LABEL[kind]}</span> : null}
              <span className="recycled-when">first deployed {relativeTime(rep.deployedAt)}</span>
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
  searchParams: Promise<{
    type?: string;
    window?: string;
    view?: string;
    network?: string;
    verified?: string;
    sectxt?: string;
    idl?: string;
    repo?: string;
    active?: string;
    authority?: string;
    category?: string;
    framework?: string;
    size?: string;
  }>;
}) {
  const sp = await searchParams;
  const type: RadarType = isRadarType(sp.type) ? sp.type : "deploy";
  const window: RadarWindow = isWindow(sp.window) ? sp.window : "today";
  // network is sticky: an explicit ?network= wins, else the persisted cookie
  // (set by the toggle), else mainnet — so leaving and returning keeps cluster.
  const cookieNetwork = (await cookies()).get("network")?.value;
  const network: Network =
    sp.network === "devnet"
      ? "devnet"
      : sp.network === "mainnet"
        ? "mainnet"
        : cookieNetwork === "devnet"
          ? "devnet"
          : "mainnet";
  const isDevnet = network === "devnet";
  const isDeploy = type === "deploy";
  const view: View | undefined = isDeploy && isView(sp.view) ? sp.view : undefined;

  // full radar state — every control serializes through this so filters compose
  // and each view stays a shareable URL
  const params: RadarParams = {
    type,
    window,
    view,
    network,
    verified: sp.verified === "1",
    sectxt: sp.sectxt === "1",
    idl: sp.idl === "1",
    repo: sp.repo === "1",
    active: sp.active === "1",
    authority: parseAuthority(sp.authority),
    category: parseCategory(sp.category),
    framework: parseFramework(sp.framework),
    size: parseSize(sp.size),
  };

  const EMPTY = { items: [] as ApiProgram[], total: 0, nextCursor: null };
  const [novelPage, variantPage, clonePage, closedPages, upgradePage, funnel] = await Promise.all([
    isDeploy ? fetchRadar({ type, window, band: "novel", limit: 100, network }) : Promise.resolve(EMPTY),
    isDeploy ? fetchRadar({ type, window, band: "variant", limit: 100, network }) : Promise.resolve(EMPTY),
    isDeploy ? fetchRadar({ type, window, band: "clone", limit: 100, network }) : Promise.resolve(EMPTY),
    // the graveyard: closed programs across all bands (rent reclaimed).
    // Devnet skips it — pre-launch churn there is expected, not a story.
    isDeploy && !isDevnet
      ? Promise.all(
          (["novel", "variant", "clone"] as const).map((band) =>
            fetchRadar({ type, window, band, closed: "only", limit: 100 }),
          ),
        )
      : Promise.resolve([]),
    !isDeploy ? fetchRadar({ type, window, limit: 50, network }) : Promise.resolve(EMPTY),
    // funnel is per-cluster now — devnet gets its own live-computed stats
    fetchFunnel(FUNNEL_WINDOW[window], network),
  ]);

  // attribute facets narrow every downstream view — the band pages, the tier
  // counts, the recycled clusters, and the main list all read from these same
  // arrays, so filtering here keeps the whole page consistent. The default
  // (no facets) path is untouched: nothing filters, nothing regresses.
  if (hasActiveFacets(params)) {
    const keep = (p: ApiProgram) => matchesFacets(p, params);
    novelPage.items = novelPage.items.filter(keep);
    variantPage.items = variantPage.items.filter(keep);
    clonePage.items = clonePage.items.filter(keep);
    upgradePage.items = upgradePage.items.filter(keep);
  }

  const ts = (p: ApiProgram) => (p.deployedAt ? Date.parse(p.deployedAt) : 0);
  const recency = (a: ApiProgram, b: ApiProgram) => ts(b) - ts(a);
  // interest ordering (the API's default sort — noveltyScore carries the
  // interest v0.1 blend); recency breaks ties so fresh unscored rows behave
  const interest = (a: ApiProgram, b: ApiProgram) =>
    (b.noveltyScore ?? 0) - (a.noveltyScore ?? 0) || recency(a, b);

  const familyKeyOf = (p: ApiProgram) => p.bucketId ?? p.id;
  const closedAll = closedPages.flatMap((p) => p.items);
  const closedTotal = closedPages.reduce((a, p) => a + (p.total ?? p.items.length), 0);
  const closedByFamily = new Map<string, ApiProgram[]>();
  for (const p of closedAll) {
    const k = familyKeyOf(p);
    const arr = closedByFamily.get(k);
    if (arr) arr.push(p);
    else closedByFamily.set(k, [p]);
  }

  // the graveyard, collapsed by family too: oldest closed member fronts the
  // pile entry, the count carries its dead siblings
  const closedItems = [...closedByFamily.values()]
    .map((ms) => {
      ms.sort(recency);
      return { rep: ms[ms.length - 1], size: ms.length, newestT: ts(ms[0]) };
    })
    .sort((a, b) => b.newestT - a.newestT);

  /** Collapse rows sharing a copy-bucket into one card. The family anchors on
   *  its FIRST sighting in the window — CLOSED OR NOT. Later duplicates only
   *  bump the ×N; and if the window's first entry is already closed, the whole
   *  family belongs to the graveyard — a fresher still-alive sibling never
   *  re-floats it into the feed. */
  const collapseBuckets = (items: ApiProgram[]): ApiProgram[] => {
    const families = new Map<string, ApiProgram>();
    for (const p of items) {
      const k = familyKeyOf(p);
      const cur = families.get(k);
      if (!cur || ts(p) < ts(cur)) families.set(k, p);
    }
    const out: ApiProgram[] = [];
    for (const [k, rep] of families) {
      const deadSibs = closedByFamily.get(k) ?? [];
      const anchorIsClosed = deadSibs.some((c) => ts(c) < ts(rep));
      if (!anchorIsClosed) out.push(rep);
    }
    return out.sort(interest);
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

  // tier counts come from the API's true row count — items cap at the page
  // limit (100), and "novel 100 · variant 100" quietly lied on wide windows.
  // Facets filter client-side over the capped page, so they keep items.length.
  const facetsActive = hasActiveFacets(params);
  const counts = isDeploy
    ? {
        novel: facetsActive ? novelPage.items.length : (novelPage.total ?? novelPage.items.length),
        variant: facetsActive ? variantPage.items.length : (variantPage.total ?? variantPage.items.length),
        recycled: facetsActive ? clonePage.items.length : (clonePage.total ?? clonePage.items.length),
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

  const header = isDevnet
    ? !isDeploy
      ? { title: "Upgrades — programs being iterated", info: "Existing devnet programs whose code changed in this window. Heavy iteration is the strongest pre-launch signal — this is where teams do the work." }
      : { title: "New programs in incubation", info: "Fresh deployments to devnet, newest first. These are pre-launch: no real users or money yet. Their code fingerprints go on the watchlist, and if one later deploys to mainnet, the radar links the two." }
    : !isDeploy
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
        params={params}
      />


      <div className="radar-controls">
        <nav className="filter-row" aria-label="New deploys or upgrades">
          {STREAM_FILTERS.map((f) => (
            <Link
              key={f.value}
              className="filter-link"
              href={withPatch(params, { type: f.value, view: undefined })}
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
              href={withPatch(params, { window: f.value })}
              aria-current={window === f.value ? "page" : undefined}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      </div>

      <RadarFilters params={params} />

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
              <ProgramRow program={program} leadWith={isDeploy ? "deploy" : "upgrade"} />
            </li>
          ))}
        </ol>
      )}

      {showRecycled ? (
        <RecycledSection
          clusters={clusters}
          count={counts?.recycled ?? clonePage.items.length}
          open={view === "recycled"}
          windowLabel={WINDOW_LABEL[window]}
        />
      ) : null}

      {isDeploy && !isDevnet ? <ClosedSection groups={closedItems} total={closedTotal} /> : null}
    </>
  );
}
