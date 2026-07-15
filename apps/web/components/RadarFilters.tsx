"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Category, Framework } from "@/lib/api";
import {
  AUTHORITY_FACETS,
  AUTHORITY_HINT,
  AUTHORITY_LABEL,
  CATEGORY_FILTER_LABEL,
  FILTER_CATEGORIES,
  FILTER_FRAMEWORKS,
  FRAMEWORK_LABEL,
  SIZE_BANDS,
  SIZE_BAND_HINT,
  SIZE_BAND_LABEL,
  buildRadarHref,
  type AuthorityFacet,
  type RadarParams,
  type SizeBand,
} from "@/lib/radar-url";

// The mutable slice of RadarParams the modal edits.
type Draft = Pick<
  RadarParams,
  "verified" | "sectxt" | "idl" | "repo" | "active" | "authority" | "category" | "framework" | "size"
>;

const EMPTY_DRAFT: Draft = {
  verified: false,
  sectxt: false,
  idl: false,
  repo: false,
  active: false,
  authority: null,
  category: null,
  framework: null,
  size: null,
};

function draftFrom(p: RadarParams): Draft {
  return {
    verified: p.verified,
    sectxt: p.sectxt,
    idl: p.idl,
    repo: p.repo,
    active: p.active,
    authority: p.authority,
    category: p.category,
    framework: p.framework,
    size: p.size,
  };
}

function activeCount(d: Draft): number {
  return (
    (d.verified ? 1 : 0) +
    (d.sectxt ? 1 : 0) +
    (d.idl ? 1 : 0) +
    (d.repo ? 1 : 0) +
    (d.active ? 1 : 0) +
    (d.authority ? 1 : 0) +
    (d.category ? 1 : 0) +
    (d.framework ? 1 : 0) +
    (d.size ? 1 : 0)
  );
}

// The tone carries the app's meaning-color language: good = green (safe /
// lean), warn = accent (risky / heavy), merit = green-on-select (a quality
// signal you're filtering FOR), neutral = no inherent good/bad.
type Tone = "good" | "warn" | "merit" | "neutral";

function Chip({
  active,
  label,
  tone = "neutral",
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  tone?: Tone;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`facet-chip tone-${tone}${active ? " active" : ""}`}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A filter group: an iconed, ruled header, then its chips. The icon + rule
 *  give each row its own identity so the modal doesn't read as five clones. */
function Group({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="facet-group">
      <span className="facet-label">
        <span className="facet-label-icon" aria-hidden="true">
          {icon}
        </span>
        {label}
        <span className="facet-label-rule" aria-hidden="true" />
      </span>
      <div className="facet-chips">{children}</div>
    </div>
  );
}

const ic = {
  status: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  authority: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
    </svg>
  ),
  category: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  framework: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12" />
    </svg>
  ),
  size: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20h18M6 20V10M12 20V4M18 20v-6" />
    </svg>
  ),
};

// tone per option on the two "meaning" axes (safe → risky, lean → heavy)
const AUTHORITY_TONE: Record<AuthorityFacet, Tone> = { frozen: "good", multisig: "neutral", hot: "warn" };
const SIZE_TONE: Record<SizeBand, Tone> = { lean: "good", moderate: "neutral", heavy: "warn" };

export function RadarFilters({ params }: { params: RadarParams }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(params));

  const appliedCount = activeCount(draftFrom(params));

  const openModal = () => {
    setDraft(draftFrom(params));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const apply = () => {
    router.push(buildRadarHref({ ...params, ...draft }), { scroll: false });
    setOpen(false);
  };

  // one-click clear of everything applied, straight from the radar (no modal)
  const clearAll = () => {
    router.push(buildRadarHref({ ...params, ...EMPTY_DRAFT }), { scroll: false });
  };

  const pick = <K extends "authority" | "category" | "framework" | "size">(
    key: K,
    value: NonNullable<Draft[K]>,
  ) => setDraft((d) => ({ ...d, [key]: d[key] === value ? null : value }));

  return (
    <div className="radar-filters">
      <span className={`filters-btn-group${appliedCount > 0 ? " has-active" : ""}`}>
        <button
          type="button"
          className={`filters-btn${appliedCount > 0 ? " has-active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openModal}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 5h18M6 12h12M10 19h4" />
          </svg>
          Filters
          {appliedCount > 0 ? <span className="filters-btn-count">{appliedCount}</span> : null}
        </button>
        {appliedCount > 0 ? (
          <button
            type="button"
            className="filters-clear-btn"
            aria-label={`Clear ${appliedCount} filter${appliedCount === 1 ? "" : "s"}`}
            title="Clear all filters"
            onClick={clearAll}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : null}
      </span>

      {open ? (
        <div
          className="filters-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Filter programs"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="filters-modal">
            <div className="filters-modal-head">
              <span className="filters-modal-title">Filters</span>
              <span className="filters-rule" aria-hidden="true" />
              <button
                type="button"
                className="filters-modal-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="filters-modal-body">
              <Group icon={ic.status} label="quality">
                <Chip
                  active={draft.verified}
                  tone="merit"
                  label="verified"
                  title="Verified build — reproduces from public source (OtterSec)"
                  onClick={() => setDraft((d) => ({ ...d, verified: !d.verified }))}
                />
                <Chip
                  active={draft.idl}
                  tone="merit"
                  label="IDL"
                  title="Publishes an on-chain IDL — a readable, Codama-ready interface"
                  onClick={() => setDraft((d) => ({ ...d, idl: !d.idl }))}
                />
                <Chip
                  active={draft.sectxt}
                  tone="merit"
                  label="security.txt"
                  title="Embeds a security.txt contact block in its binary"
                  onClick={() => setDraft((d) => ({ ...d, sectxt: !d.sectxt }))}
                />
                <Chip
                  active={draft.repo}
                  tone="merit"
                  label="repo"
                  title="Links a public source repository"
                  onClick={() => setDraft((d) => ({ ...d, repo: !d.repo }))}
                />
                <Chip
                  active={draft.active}
                  tone="merit"
                  label="active"
                  title="Had transactions in the last 24h — not a dead deploy"
                  onClick={() => setDraft((d) => ({ ...d, active: !d.active }))}
                />
              </Group>

              <Group icon={ic.authority} label="authority">
                {AUTHORITY_FACETS.map((a: AuthorityFacet) => (
                  <Chip
                    key={a}
                    active={draft.authority === a}
                    tone={AUTHORITY_TONE[a]}
                    label={AUTHORITY_LABEL[a]}
                    title={AUTHORITY_HINT[a]}
                    onClick={() => pick("authority", a)}
                  />
                ))}
              </Group>

              <Group icon={ic.category} label="category">
                {FILTER_CATEGORIES.map((cat: Category) => (
                  <Chip
                    key={cat}
                    active={draft.category === cat}
                    label={CATEGORY_FILTER_LABEL[cat]}
                    onClick={() => pick("category", cat)}
                  />
                ))}
              </Group>

              <Group icon={ic.framework} label="framework">
                {FILTER_FRAMEWORKS.map((fw: Framework) => (
                  <Chip
                    key={fw}
                    active={draft.framework === fw}
                    label={FRAMEWORK_LABEL[fw]}
                    title={
                      fw === "anchor"
                        ? "Anchor — the one framework reliably fingerprinted on-chain"
                        : `${FRAMEWORK_LABEL[fw]} — inferred from binary shape`
                    }
                    onClick={() => pick("framework", fw)}
                  />
                ))}
              </Group>

              <Group icon={ic.size} label="size">
                {SIZE_BANDS.map((s: SizeBand) => (
                  <Chip
                    key={s}
                    active={draft.size === s}
                    tone={SIZE_TONE[s]}
                    label={SIZE_BAND_LABEL[s]}
                    title={SIZE_BAND_HINT[s]}
                    onClick={() => pick("size", s)}
                  />
                ))}
              </Group>
            </div>

            <div className="filters-modal-foot">
              <button
                type="button"
                className="filters-clear"
                onClick={() => setDraft(EMPTY_DRAFT)}
                disabled={activeCount(draft) === 0}
              >
                Clear all
              </button>
              <button type="button" className="filters-apply" onClick={apply}>
                Apply
                {activeCount(draft) > 0 ? (
                  <span className="filters-apply-count">{activeCount(draft)}</span>
                ) : null}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
