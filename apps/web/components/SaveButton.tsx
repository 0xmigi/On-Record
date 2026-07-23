"use client";

import { useEffect, useState } from "react";
import { isSaved, subscribeSaved, toggleSaved } from "@/lib/saved";

/** Star outline / filled — matches the header icon set (currentColor, 15px). */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 11.2l-3.52 1.85.67-3.92L2.3 6.34l3.94-.57z" />
    </svg>
  );
}

/**
 * Save a program to the device-local shortlist. Saved state lives in
 * localStorage, so it can only be read after mount — we render the unsaved
 * state on the server and reconcile in an effect (same approach as
 * NetworkToggle) to avoid a hydration mismatch.
 */
export function SaveButton({
  id,
  name = null,
  category = null,
  network,
}: {
  id: string;
  name?: string | null;
  category?: string | null;
  network?: "mainnet" | "devnet";
}) {
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const sync = () => setSaved(isSaved(id));
    sync();
    return subscribeSaved(sync);
  }, [id]);

  return (
    <button
      type="button"
      className={`save-btn${saved ? " is-saved" : ""}`}
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved" : "Save this program"}
      title={saved ? "Saved — click to remove" : "Save for later"}
      onClick={(e) => {
        // radar rows have a full-card link overlay; don't navigate on save
        e.preventDefault();
        e.stopPropagation();
        setSaved(toggleSaved({ id, name, category, network }));
      }}
    >
      <StarIcon filled={saved} />
      <span>{saved ? "saved" : "save"}</span>
    </button>
  );
}
