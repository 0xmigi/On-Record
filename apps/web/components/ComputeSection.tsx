"use client";

import { useEffect, useRef, useState } from "react";
import { ComputeBar } from "@/components/ComputeBar";
import type { ComputeMissReason, ComputeProfileData, ComputeRankData } from "@/lib/api";

/** How old a stored reading may be before opening the page pays to retake it.
 *  Must match COMPUTE_MAX_AGE_H on the API — the server is what enforces it;
 *  this only avoids a request that would be declined anyway. */
const STALE_MS = 24 * 3_600_000;

/**
 * "Compute per transaction", and the thing that measures it.
 *
 * Same bargain as UsageSection: a reading costs one getTransaction per sampled
 * signature, so the question is always *when* to pay. This pays on a real open
 * — the page renders whatever was last stored, and only if that is missing or
 * a day old does an effect ask the API for one. The result is written through,
 * so the next visitor reads it free, and so do the card and the dossier.
 *
 * An effect rather than the server render, deliberately. Server rendering also
 * happens on link prefetch, when a row scrolls past on the feed and nobody has
 * opened anything; paying there is what once enrolled 6,000 programs in a paid
 * refresh loop.
 */
export function ComputeSection({
  programId,
  initialCompute,
  initialRank,
}: {
  programId: string;
  initialCompute: ComputeProfileData | null;
  initialRank: ComputeRankData | null;
}) {
  const [compute, setCompute] = useState(initialCompute);
  const [rank, setRank] = useState(initialRank);
  const [measuring, setMeasuring] = useState(false);
  const [reason, setReason] = useState<ComputeMissReason | null>(null);
  // React runs effects twice in development; one open must mean one reading
  const asked = useRef(false);

  useEffect(() => {
    // Stale on shape as well as on the clock, matching `isStale` on the API: a
    // reading taken before the spread and the requested figure existed has a
    // median and nothing to draw a bar with, and asking for a fresh one is the
    // only thing that fixes it.
    const partial = compute !== null && (typeof compute.max !== "number" || typeof compute.noLimit !== "number");
    const age = compute ? Date.now() - Date.parse(compute.sampledAt) : Infinity;
    if (asked.current || (age < STALE_MS && !partial)) return;
    asked.current = true;
    let live = true;
    setMeasuring(true);
    fetch(`/api/compute/${encodeURIComponent(programId)}`, { method: "POST" })
      .then((r) => r.json())
      .then(
        (r: {
          compute: ComputeProfileData | null;
          computeRank: ComputeRankData | null;
          reason?: ComputeMissReason | null;
        }) => {
          if (!live) return;
          // Only ever replace a reading with a reading. Blanking what we already
          // rendered would turn "we did not measure" into "there is nothing here".
          if (!r.compute) {
            setReason(r.reason ?? "failed");
            return;
          }
          setCompute(r.compute);
          setRank(r.computeRank ?? null);
        },
      )
      .catch(() => {
        if (live) setReason("failed");
      })
      .finally(() => {
        if (live) setMeasuring(false);
      });
    return () => {
      live = false;
    };
  }, [programId, compute]);

  if (compute) {
    return (
      <div style={{ marginBottom: 18 }}>
        <ComputeBar compute={compute} rank={rank} />
      </div>
    );
  }
  if (measuring) {
    return (
      <div style={{ marginBottom: 18 }} className="usage-measuring">
        <span className="cell-dim">measuring…</span>
      </div>
    );
  }
  // Nothing to show, and the reason decides the words. "Too quiet" is a fact
  // about the program and gets said as one — telling a reader to wait for a
  // measurement that will never arrive is the worse of the two errors. Neither
  // line may ever read as "this program uses no compute".
  return (
    <div style={{ marginBottom: 18 }}>
      <span className="cell-dim">
        {reason === "too-quiet"
          ? "Too few transactions to measure."
          : reason === "budget"
            ? "Not measured yet — check back shortly."
            : "Not sampled yet."}
      </span>
    </div>
  );
}
