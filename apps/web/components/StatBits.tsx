// Small pieces shared by the stats page and its client views.
import Link from "next/link";
import { Trend } from "@/components/Trend";
import { SectionHeader } from "@/components/SectionHeader";

const groupNum = (n: number) => n.toLocaleString("en-US");

/** `fill`: the bar's colour when it is not the default single hue. */
export type MeterLine = {
  value: React.ReactNode;
  frac: number;
  tip?: string;
  /** change over the window, in points */
  trend?: { pp: number; title: string } | null;
};
export type MeterRow = MeterLine & {
  label: string;
  fill?: string;
  href?: string;
  /** on all networks: the same figure for devnet, drawn hatched right under */
  dev?: MeterLine | null;
};

const fillStyle = (frac: number, fill?: string) => ({
  width: `${Math.max(0, Math.min(1, frac)) * 100}%`,
  ...(fill ? { background: fill } : {}),
});

/** One row per item: its name and figure, a thin bar under them. With a
 *  devnet line on any row, each row is its name, then mainnet's bar (solid)
 *  and devnet's (hatched) close together, each with its figure at the right;
 *  the bars line up across rows. */
/** `inline`: name, bar and figure on one line, for full-width cards, so a
 *  ranked list reads straight down instead of zigzagging across columns. */
export function MeterList({ rows, inline = false }: { rows: MeterRow[]; inline?: boolean }) {
  if (rows.some((r) => r.dev)) {
    return (
      <div className="meters is-pair">
        {rows.map((r) => {
          const line = (l: MeterLine, dev: boolean) => (
            <>
              <span className={`pair-track${dev ? " is-dev" : ""}`}>
                <span className="meter-row-fill" style={fillStyle(l.frac, r.fill)} />
              </span>
              <span className={`pair-value${dev ? " is-dev" : ""}${l.tip ? " count-tip" : ""}`} data-count={l.tip}>
                {l.trend ? <Trend pp={l.trend.pp} title={l.trend.title} /> : null}
                {l.value}
              </span>
            </>
          );
          const body = (
            <>
              <span className="pair-label">{r.label}</span>
              {line(r, false)}
              {r.dev ? line(r.dev, true) : null}
            </>
          );
          return r.href ? (
            <Link className="pair-row is-link" href={r.href} key={r.label}>
              {body}
            </Link>
          ) : (
            <div className="pair-row" key={r.label}>
              {body}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className={`meters${inline ? " meters-inline" : ""}`}>
      {rows.map((r) => {
        const body = (
          <>
            <span className="meter-row-top">
              <span className="meter-row-label">{r.label}</span>
              <span className={`meter-row-value${r.tip ? " count-tip" : ""}`} data-count={r.tip}>
                {r.trend ? <Trend pp={r.trend.pp} title={r.trend.title} /> : null}
                {r.value}
              </span>
            </span>
            <span className="meter-row-track">
              <span className="meter-row-fill" style={fillStyle(r.frac, r.fill)} />
            </span>
          </>
        );
        return r.href ? (
          <Link className="meter-row is-link" href={r.href} key={r.label}>
            {body}
          </Link>
        ) : (
          <div className="meter-row" key={r.label}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** Two figures side by side, mainnet's then devnet's, each after a small
 *  solid or hatched swatch, the way the bars tell them apart. */
export function PairFigures({ main, dev }: { main: React.ReactNode; dev: React.ReactNode }) {
  return (
    <span className="pair-figs">
      <span className="pair-fig">
        <span className="pair-swatch" />
        {main}
      </span>
      <span className="pair-fig">
        <span className="pair-swatch is-dev" />
        {dev}
      </span>
    </span>
  );
}

/** A related figure at the foot of a card, on its own ruled line: its label,
 *  its value, and where it opens when it links somewhere. */
export function CardFoot({
  label,
  value,
  devValue,
  href,
}: {
  label: string;
  value: string;
  /** on all networks: devnet's figure beside mainnet's */
  devValue?: string | null;
  href?: string;
}) {
  const body = (
    <>
      <span className="card-foot-label">{label}</span>
      <span className="card-foot-value">
        {devValue != null ? <PairFigures main={value} dev={devValue} /> : value}
        {href ? " →" : ""}
      </span>
    </>
  );
  return href ? (
    <Link className="card-foot is-link" href={href}>
      {body}
    </Link>
  ) : (
    <div className="card-foot">{body}</div>
  );
}


/** One whole in two or three parts: a tall bar, each share printed in its
 *  block where it fits, the names and counts in a legend below. */
export function TallSplit({ parts }: { parts: { label: string; n: number; tone: "has" | "rest" | "s1" | "s2" | "s3" | "s4"; href?: string }[] }) {
  // the key is a list, one part per line: name, share, count
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (total === 0) return null;
  return (
    <div className="tall">
      <div className="tall-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(", ")}>
        {parts
          .filter((p) => p.n > 0)
          .map((p) => {
            const share = (p.n / total) * 100;
            return (
              <span key={p.label} className={`tall-seg tone-${p.tone}`} style={{ width: `${share}%` }} title={`${p.label} ${groupNum(p.n)}`}>
                {share >= 14 ? `${Math.round(share)}%` : ""}
              </span>
            );
          })}
      </div>
      <div className="tall-legend">
        {parts.map((p) => {
          const item = (
            <>
              <span className={`tall-swatch tone-${p.tone}`} />
              <span className="tall-key-name">{p.label}</span>
              <span className="tall-key-share">{fmtShare((p.n / total) * 100)}%</span>
              <span className="tall-n">{groupNum(p.n)}</span>
            </>
          );
          return p.href ? (
            <Link key={p.label} href={p.href} className="tall-key is-link">
              {item}
            </Link>
          ) : (
            <span key={p.label} className="tall-key">
              {item}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** A card's title, with an optional key at the right. */
export function CardHead({ title, info, aside }: { title: string; info: string; aside?: React.ReactNode }) {
  return (
    <div className="card-head">
      <SectionHeader title={title} info={info} />
      {aside}
    </div>
  );
}

/** The has-it / doesn't key for two-sided rows. */
export function HasKey() {
  return (
    <span className="card-key">
      <span className="card-key-item">
        <span className="tall-swatch tone-has" /> has it
      </span>
      <span className="card-key-item">
        <span className="tall-swatch tone-rest" /> doesn't
      </span>
    </span>
  );
}

/** One row per yes/no fact: its name, a bar showing both sides (has it /
 *  doesn't), each share printed in its side where it fits, the has-share at
 *  the end. One legend for the list. */
/** a share as text: a decimal near 0% and 100%, where rounding would lie */
export const fmtShare = (x: number) => (x < 10 || x > 90 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));

type Split = { has: number; total: number };

export function SplitRows({
  rows,
}: {
  rows: { label: string; has: number; total: number; href?: string; /** devnet, hatched under */ dev?: Split | null }[];
}) {
  const paired = rows.some((r) => r.dev);
  const share = (x: Split) => (x.total > 0 ? (x.has / x.total) * 100 : 0);
  const ofText = (x: Split) => (x.total > 0 ? `${groupNum(x.has)} of ${groupNum(x.total)} programs` : "no programs");
  const bar = (r: { label: string } & Split, dev: boolean, labelled: boolean) => {
    const sh = share(r);
    return (
      <span
        className={`split-row-bar${dev ? " is-dev" : ""}`}
        role="img"
        aria-label={`${r.label}${paired ? (dev ? ", devnet" : ", mainnet") : ""}: ${sh.toFixed(1)}% have it`}
      >
        {r.has > 0 ? (
          <span className="tall-seg tone-has" style={{ width: `${sh}%` }}>
            {labelled && sh >= 12 ? `${fmtShare(sh)}%` : ""}
          </span>
        ) : null}
        <span className="tall-seg tone-rest" style={{ width: `${100 - sh}%` }} />
      </span>
    );
  };
  return (
    <div className={`splits${paired ? " is-pair" : ""}`}>
      {rows.map((r) => {
        const body = paired ? (
          <>
            <span className="split-row-label">{r.label}</span>
            <span className="split-pair">
              {bar(r, false, false)}
              {r.dev ? bar({ label: r.label, ...r.dev }, true, false) : null}
            </span>
            <span className="split-pair-values">
              <span className="count-tip" data-count={ofText(r)}>
                {r.total > 0 ? `${fmtShare(share(r))}%` : "–"}
              </span>
              {r.dev ? (
                <span className="count-tip" data-count={ofText(r.dev)}>
                  {r.dev.total > 0 ? `${fmtShare(share(r.dev))}%` : "–"}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <span className="split-row-label">{r.label}</span>
            {bar(r, false, true)}
            <span className="split-row-value count-tip" data-count={ofText(r)}>
              {fmtShare(share(r))}%
            </span>
          </>
        );
        return r.href ? (
          <Link className="split-row is-link" href={r.href} key={r.label}>
            {body}
          </Link>
        ) : (
          <div className="split-row" key={r.label}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

