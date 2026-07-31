"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adoptKey, pullRemote, readSaved, removeSaved, subscribeSaved, syncKey, type SavedProgram } from "@/lib/saved";
import { truncateAddress } from "@/lib/format";

/**
 * The personal shortlist. Renders from localStorage — instant, works offline —
 * and backs itself up to the API under a random key. `null` means "not read
 * yet" (pre-mount), which is distinct from "read, and empty".
 *
 * The backup exists because localStorage alone lost a real list to a routine
 * cache clear. `?k=<key>` on this page adopts a list from a bookmarked link,
 * which is the whole recovery story: no account, one bookmark.
 */
export default function SavedPage() {
  const [list, setList] = useState<SavedProgram[] | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sync = () => setList(readSaved());
    // a ?k= link means "this is my list" — adopt it, pull it down, then drop
    // the key from the address bar so it isn't left sitting in history
    const fromLink = new URLSearchParams(window.location.search).get("k");
    const boot = async () => {
      if (fromLink) {
        await adoptKey(fromLink);
        window.history.replaceState(null, "", "/saved");
      } else {
        const n = await pullRemote();
        if (n) setRestored(n);
      }
      setKey(syncKey());
      sync();
    };
    void boot();
    return subscribeSaved(sync);
  }, []);

  const bookmarkUrl = key ? `${typeof window === "undefined" ? "" : window.location.origin}/saved?k=${key}` : null;
  const copyBookmark = async () => {
    if (!bookmarkUrl) return;
    try {
      await navigator.clipboard.writeText(bookmarkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked — the link is on screen to copy by hand
    }
  };

  return (
    <>
      <h1 className="funnel-title">Saved</h1>

      {list === null ? null : list.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <p className="empty-title">Nothing saved yet</p>
          <p className="saved-hint">
            Hit <strong>save</strong> on a program page to keep it here — for the ones you want to
            come back to and write about.
          </p>
        </div>
      ) : (
        <>
          <p className="saved-hint">
            {list.length} program{list.length === 1 ? "" : "s"}
            {list.some((p) => p.network === "devnet")
              ? ` · ${list.filter((p) => p.network === "devnet").length} on devnet`
              : ""}
            {restored ? ` · ${restored} restored from backup` : ""}
          </p>
          {bookmarkUrl ? (
            <div className="saved-backup">
              <div className="saved-backup-copy">
                <strong>Bookmark this link.</strong> It restores this list on any browser, and
                after a cache clear. Anyone with it can see the list — there is no account.
              </div>
              <div className="saved-backup-row">
                <code className="saved-backup-url">{bookmarkUrl}</code>
                <button type="button" className="saved-backup-btn" onClick={copyBookmark}>
                  {copied ? "copied" : "copy"}
                </button>
              </div>
            </div>
          ) : null}
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
