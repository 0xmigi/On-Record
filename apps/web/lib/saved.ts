// ---------------------------------------------------------------------------
// Saved programs — a personal, device-local shortlist. No accounts, no backend.
//
// We snapshot the few display fields at save time (name, category) rather than
// storing bare ids, so the Saved view renders instantly from localStorage with
// no API round-trip. Each row still links to the live dossier, which is the
// source of truth — the snapshot is only ever used as a label.
//
// Same spirit as the network cookie in NetworkToggle: read after mount, never
// during SSR. Upgrade path if this ever needs to sync across devices: key rows
// by wallet pubkey (sign-in-with-Solana) and merge this list up on first login.
// ---------------------------------------------------------------------------

export interface SavedProgram {
  id: string;
  name: string | null;
  category: string | null;
  /** which cluster this program lives on. Saving across both and then opening
   *  a devnet row used to land on a page with no devnet indication at all —
   *  the banner keys off browsing mode, not off the subject. Stored so the
   *  list can label the row and link with ?network=, and absent on rows saved
   *  before this shipped (treat undefined as mainnet, never assert). */
  network?: "mainnet" | "devnet";
  savedAt: number; // epoch ms
}

const KEY = "onrecord:saved";
/** fired on same-tab writes; the native `storage` event covers other tabs */
const EVENT = "onrecord:saved-changed";

export function readSaved(): SavedProgram[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SavedProgram => Boolean(e) && typeof (e as SavedProgram).id === "string",
    );
  } catch {
    return []; // unparseable / storage blocked — behave as empty, never throw
  }
}

function write(list: SavedProgram[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode or quota — the toggle still reflects in-memory state
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function isSaved(id: string): boolean {
  return readSaved().some((e) => e.id === id);
}

/** Toggle a program. Returns the NEW saved state. Newest-first ordering. */
export function toggleSaved(entry: Omit<SavedProgram, "savedAt">): boolean {
  const list = readSaved();
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0) {
    list.splice(i, 1);
    write(list);
    return false;
  }
  write([{ ...entry, savedAt: Date.now() }, ...list]);
  return true;
}

export function removeSaved(id: string): void {
  write(readSaved().filter((e) => e.id !== id));
}

/** Keeps every star on the page in sync, plus other tabs. Returns unsubscribe. */
export function subscribeSaved(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
