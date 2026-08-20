"use client";

import { useState } from "react";
import {
  orbTx,
  type ApiProgramDetail,
  type ApiRawEvent,
  type ApiVersionDiff,
  type VersionTrail,
} from "@/lib/api";
import { isSyntheticSignature, relativeTime, truncateAddress } from "@/lib/format";
import { describe, isProgramPath, type Statement } from "@/lib/changelog";
import { Chevron } from "@/components/Chevron";

/**
 * The record table — every loader event on a program id, with what changed.
 *
 * The table already listed every upgrade; it just never said what the upgrade
 * DID. Each upgrade row now carries a one-line summary and expands to the
 * delta: instructions gained or lost, source files that appeared, integrations
 * picked up. All of it comes from the per-version description the pipeline
 * already writes into events.enrichment on every upgrade — no bytecode is
 * stored and no extra RPC call is made.
 *
 * The flags matter more than the diff. Two things routinely make a version look
 * like it changed when it didn't: the instruction-name list is capped, so names
 * drop off an alphabetical tail as others are added; and the name SOURCE can
 * switch (recovered PascalCase → IDL snake_case), which reads as a total
 * rewrite. Both are detected and either suppressed or withheld, because a diff
 * that quietly invents a removed instruction is worse than no diff at all.
 */

export type TrailEntry = ApiVersionDiff;
export type Trail = VersionTrail;

const EVENT_LABELS: Record<ApiRawEvent["type"], string> = {
  deploy: "DEPLOY",
  upgrade: "UPGRADE",
  set_authority: "SET AUTHORITY",
  close: "CLOSE",
};

const MAX_CHIPS = 12;
const MAX_PATHS = 8;

function fmtDelta(n: number): string {
  const a = Math.abs(n);
  const s = n > 0 ? "+" : n < 0 ? "−" : "";
  if (a >= 1024 * 1024) return `${s}${(a / 1048576).toFixed(2)} MB`;
  if (a >= 1024) return `${s}${(a / 1024).toFixed(a < 10240 ? 1 : 0)} KB`;
  return `${s}${a} B`;
}

// the crate prefix repeats on every path and buys nothing in a list
const shortPath = (p: string) => p.replace(/^programs?\/[a-z0-9_-]+\//i, "");

/** the counting fallback, only used when nothing could be said in words */
function countSummary(t: TrailEntry): string {
  const n = (t.instructions?.added.length ?? 0) + (t.instructions?.removed.length ?? 0);
  const f = (t.sourcePaths?.added ?? []).filter(isProgramPath).length;
  if (n) return `${n} instruction${n > 1 ? "s" : ""} changed`;
  if (f) return `${f} source file${f > 1 ? "s" : ""} changed`;
  return "rebuilt — no change to the interface";
}

function Chips({ names, tone }: { names: string[]; tone: "add" | "rem" }) {
  if (!names.length) return null;
  const shown = names.slice(0, MAX_CHIPS);
  const rest = names.length - shown.length;
  return (
    <div className="trail-chips">
      {shown.map((n) => (
        <span key={n} className={`trail-chip trail-chip-${tone}`}>
          {tone === "add" ? "+" : "−"}
          {n}
        </span>
      ))}
      {rest > 0 ? <span className="trail-more">+{rest} more</span> : null}
    </div>
  );
}

function Detail({ t, said }: { t: TrailEntry; said: Statement[] }) {
  // vendor paths are the Rust standard library compiled into the image, not
  // the author's code — listing them as changed files is simply wrong
  const paths = [
    ...(t.sourcePaths?.added ?? []).filter(isProgramPath).map((p) => [p, "add"] as const),
    ...(t.sourcePaths?.removed ?? []).filter(isProgramPath).map((p) => [p, "rem"] as const),
  ];
  const shownPaths = paths.slice(0, MAX_PATHS);
  const hasIx = (t.instructions?.added.length ?? 0) + (t.instructions?.removed.length ?? 0) > 0;
  // the withheld count and the row's `!` describe the same cap — say it in the
  // same words, which the API writes per program (it carries the real number)
  const cappedTip = t.flags?.find((f) => f.type === "unreliable")?.detail;

  return (
    <div className="trail-detail">
      {said.length > 1 ? (
        <ul className="trail-said-list">
          {said.slice(1).map((s) => (
            <li key={s.text} className={`trail-said trail-said-${s.tone}`}>
              {s.text}
            </li>
          ))}
        </ul>
      ) : null}

      {hasIx ? (
        <div className="trail-grp">
          <span className="trail-lbl">Instructions</span>
          <Chips names={t.instructions?.added ?? []} tone="add" />
          <Chips names={t.instructions?.removed ?? []} tone="rem" />
          {t.instructions?.removedHidden ? (
            <span className="trail-more tip" data-tip={cappedTip} tabIndex={0} role="note">
              {t.instructions.removedHidden} apparent removal
              {t.instructions.removedHidden > 1 ? "s" : ""} withheld
            </span>
          ) : null}
        </div>
      ) : null}

      {shownPaths.length ? (
        <div className="trail-grp">
          <span className="trail-lbl">Source files</span>
          <div className="trail-paths">
            {shownPaths.map(([p, tone]) => (
              <div key={p} className={`trail-path trail-path-${tone}`}>
                <span className="trail-sign">{tone === "add" ? "+" : "−"}</span>
                <span>{shortPath(p)}</span>
              </div>
            ))}
            {paths.length > shownPaths.length ? (
              <div className="trail-more">+{paths.length - shownPaths.length} more</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {t.integrations?.added.length ? (
        <div className="trail-grp">
          <span className="trail-lbl">Integrations</span>
          <Chips names={t.integrations.added} tone="add" />
        </div>
      ) : null}

      {t.capabilities?.added.length ? (
        <div className="trail-grp">
          <span className="trail-lbl">Capabilities</span>
          <Chips names={t.capabilities.added} tone="add" />
        </div>
      ) : null}

      {t.sizeDelta != null ? (
        <div className="trail-grp">
          <span className="trail-lbl">Build size</span>
          <span className={`trail-size ${t.sizeDelta > 0 ? "up" : t.sizeDelta < 0 ? "down" : ""}`}>
            {fmtDelta(t.sizeDelta)}
          </span>
        </div>
      ) : null}

      {/* one line, not a banner — the full reasoning is in the title and in
          the footnote under the table, so it doesn't shout on every row */}
      {(t.flags ?? []).map((f) => (
        <p
          key={f.label}
          className={`trail-note trail-note-${f.type} tip`}
          data-tip={f.detail}
          tabIndex={0}
          role="note"
        >
          <span className="trail-note-mark">{f.type === "unreliable" ? "!" : "~"}</span>
          {f.label}
        </p>
      ))}
    </div>
  );
}

function Ext({ href, text }: { href: string; text: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

export function RecordTable({
  events,
  trail,
}: {
  events: ApiProgramDetail["events"];
  trail: Trail;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // No versions at all for this program? Drop the column rather than printing
  // "not captured" down the whole table. That covers a program we genuinely
  // hold nothing for AND the window where the web deploys ahead of the API —
  // in both cases the record renders exactly as it did before this feature.
  const hasTrail = Object.keys(trail).length > 0;

  return (
    <div className="table-scroll">
      <table className="record-table trail-table">
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">When</th>
            <th scope="col">Detail</th>
            {hasTrail ? <th scope="col">What changed</th> : null}
            <th scope="col">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => {
            const t = trail[String(ev.slot)];
            const isOpen = open.has(ev.id);
            const expandable = !!t && t.kind !== "genesis";
            // the sentence(s) this version earns — empty for a plain rebuild
            const said = t && t.kind !== "genesis" ? describe(t) : [];
            return [
              <tr
                key={ev.id}
                className={`trail-row-${ev.type}${isOpen ? " trail-row-open" : ""}`}
              >
                <td>
                  <span className={`evt-tag evt-${ev.type}`}>{EVENT_LABELS[ev.type]}</span>
                </td>
                <td className="cell-dim">{ev.blockTime ? relativeTime(ev.blockTime) : "—"}</td>
                <td>slot {ev.slot.toLocaleString("en-US")}</td>
                {hasTrail ? (
                <td className="trail-cell">
                  {!t ? (
                    <span
                      className="cell-dim"
                      title="This event predates fingerprinting, so there is no description of the program at this version"
                    >
                      not captured
                    </span>
                  ) : expandable ? (
                    <button
                      type="button"
                      className={`trail-toggle trail-${t.kind}`}
                      aria-expanded={isOpen}
                      onClick={() => toggle(ev.id)}
                    >
                      <Chevron className={isOpen ? "chev-open" : undefined} />
                      {/* one inline run, so a long summary wraps as text
                          instead of each flex child landing on its own line */}
                      <span className="trail-sum">
                        <span className={said.length ? `trail-said trail-said-${said[0].tone}` : undefined}>
                          {said.length ? said[0].text : countSummary(t)}
                        </span>
                        {said.length > 1 ? (
                          <span className="trail-plus">+{said.length - 1} more</span>
                        ) : null}
                        {/* one marker per flag, and the two mean different
                            things: `!` is "part of this diff is missing", `~`
                            is "part of it is cosmetic". A single glyph for both
                            left the reader unable to tell whether the sentence
                            they just read was affected. */}
                        {(t.flags ?? []).map((f) => (
                          <span
                            key={f.label}
                            className={`trail-warn trail-warn-${f.type} tip`}
                            data-tip={f.detail}
                            tabIndex={0}
                            role="note"
                            aria-label={f.detail}
                          >
                            {f.type === "unreliable" ? "!" : "~"}
                          </span>
                        ))}
                      </span>
                    </button>
                  ) : (
                    <span className="cell-dim">
                      first version on record — {t.counts?.instructions ?? 0} instructions
                    </span>
                  )}
                </td>
                ) : null}
                <td className={isSyntheticSignature(ev.signature) ? "trail-no-receipt" : undefined}>
                  {isSyntheticSignature(ev.signature) ? (
                    <span
                      className="cell-dim"
                      title="Observed from ProgramData account state — no transaction signature to cite"
                    >
                      —
                    </span>
                  ) : (
                    <Ext href={orbTx(ev.signature)} text={truncateAddress(ev.signature)} />
                  )}
                </td>
              </tr>,
              isOpen && t ? (
                <tr key={`${ev.id}-d`} className="trail-detail-row">
                  <td colSpan={hasTrail ? 5 : 4}>
                    <Detail t={t} said={said} />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
