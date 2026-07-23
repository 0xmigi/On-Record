"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readSaved, removeSaved, subscribeSaved, type SavedProgram } from "@/lib/saved";
import { truncateAddress } from "@/lib/format";

/**
 * The personal shortlist. Renders entirely from localStorage — no API call —
 * so it's instant and works offline. `null` means "not read yet" (pre-mount),
 * which is distinct from "read, and empty".
 */
export default function SavedPage() {
  const [list, setList] = useState<SavedProgram[] | null>(null);

  useEffect(() => {
    const sync = () => setList(readSaved());
    sync();
    return subscribeSaved(sync);
  }, []);

  return (
    <>
      <h1 className="funnel-title">Saved</h1>

      {list === null ? null : list.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <p className="empty-title">Nothing saved yet</p>
          <p className="saved-hint">
            Hit <strong>save</strong> on a program page to keep it here — for the ones you want to
            come back to and write about. Stored in this browser only.
          </p>
        </div>
      ) : (
        <>
          <p className="saved-hint">
            {list.length} program{list.length === 1 ? "" : "s"} · stored in this browser only
            {list.some((p) => p.network === "devnet")
              ? ` · ${list.filter((p) => p.network === "devnet").length} on devnet`
              : ""}
          </p>
          <div className="facts-panel saved-list">
            {list.map((p) => (
              <div className="saved-row" key={p.id}>
                <Link
                  className="saved-link"
                  // carry the cluster so the destination opens in the right
                  // mode; the dossier's own banner is authoritative either way
                  href={p.network === "devnet" ? `/p/${p.id}?network=devnet` : `/p/${p.id}`}
                >
                  <span className="saved-name">{p.name ?? truncateAddress(p.id)}</span>
                  {p.name ? <span className="saved-addr">{truncateAddress(p.id)}</span> : null}
                </Link>
                {p.network === "devnet" ? (
                  <span className="net-badge" title="This program is on devnet">
                    devnet
                  </span>
                ) : null}
                {p.category && p.category !== "unknown" ? (
                  <span className="ix-chip">{p.category}</span>
                ) : null}
                <span className="saved-when">
                  {new Date(p.savedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <button
                  type="button"
                  className="saved-remove"
                  onClick={() => removeSaved(p.id)}
                  aria-label={`Remove ${p.name ?? p.id} from saved`}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
