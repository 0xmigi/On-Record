"use client";

import { useEffect, useRef, useState } from "react";
import { UsageBars } from "@/components/UsageBars";
import type { InstructionUsage } from "@/lib/api";

/** How old a stored sample may be before opening the page pays to refresh it.
 *  Must match USAGE_FILL_STALE_MS on the API — the server is the one that
 *  enforces it; this only avoids a request that would be declined anyway. */
const STALE_MS = 7 * 24 * 3_600_000;

/**
 * "How it's used", and the thing that measures it.
 *
 * Reading a program's instruction mix costs Helius credits, so the question is
 * always *when* to pay. This pays on a real open: the page renders whatever was
 * last stored, and if that is missing or over a week old, this effect asks the
 * API to measure once. The result is written to the database, so the next
 * visitor — and every visitor for the following week — reads it for free.
 *
 * The effect, rather than the server render, is deliberate. Server rendering
 * also happens on link prefetch, when a row scrolls past on the feed and nobody
 * has opened anything. Paying there is what put a paid refresh on 6,000
 * programs nobody asked for. An effect runs only after an actual navigation.
 */
export function UsageSection({
  programId,
  initialUsage,
  initialSampledAt,
  compact = false,
}: {
  programId: string;
  initialUsage: InstructionUsage | null;
  initialSampledAt: string | null;
  compact?: boolean;
}) {
  const [usage, setUsage] = useState(initialUsage);
  const [sampledAt, setSampledAt] = useState(initialSampledAt);
  const [measuring, setMeasuring] = useState(false);
  // React runs effects twice in development; one open must mean one measurement
  const asked = useRef(false);

  useEffect(() => {
    const age = sampledAt ? Date.now() - Date.parse(sampledAt) : Infinity;
    if (asked.current || age < STALE_MS) return;
    asked.current = true;
    let live = true;
    setMeasuring(true);
    fetch(`/api/usage/${encodeURIComponent(programId)}`, { method: "POST" })
      .then((r) => r.json())
      .then((r: { usage: InstructionUsage | null; sampledAt: string | null }) => {
        if (!live) return;
        setUsage(r.usage ?? null);
        setSampledAt(r.sampledAt ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setMeasuring(false);
      });
    return () => {
      live = false;
    };
  }, [programId, sampledAt]);

  if (usage && usage.instructions.length) {
    return (
      <div style={{ marginBottom: 18 }}>
        <UsageBars usage={usage} sampledAt={sampledAt} compact={compact} />
      </div>
    );
  }
  // Only while a measurement is actually running. A program with no IDL, or no
  // transactions yet, falls through to nothing — same as before.
  if (measuring) {
    return (
      <div style={{ marginBottom: 18 }} className="usage-measuring">
        <span className="cell-dim">measuring how it&apos;s used…</span>
      </div>
    );
  }
  return null;
}
