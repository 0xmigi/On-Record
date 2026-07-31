// ---------------------------------------------------------------------------
// Saved programs — a personal shortlist. No accounts.
//
// We snapshot the few display fields at save time (name, category) rather than
// storing bare ids, so the Saved view renders instantly from localStorage with
// no API round-trip. Each row still links to the live dossier, which is the
// source of truth — the snapshot is only ever used as a label.
//
// Same spirit as the network cookie in NetworkToggle: read after mount, never
// during SSR.
//
// It also syncs to the API under a random key, because localStorage alone lost
// a real list to a routine cache clear with nothing to restore from. The key is
// minted here, stored locally, and shown on /saved as a bookmarkable link —
// whoever holds the link holds the list. That is a capability, not an identity:
// no login, no email, and nothing personal in it, since every entry is a public
// program address.
//
// localStorage stays the source of truth for rendering (instant, offline). The
// server copy is a backup that a wiped browser can adopt.
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
const KEY_SYNC = "onrecord:saved-key";
/** fired on same-tab writes; the native `storage` event covers other tabs */
const EVENT = "onrecord:saved-changed";

/** The capability key for this browser, minted on first use. */
export function syncKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let k = window.localStorage.getItem(KEY_SYNC);
    if (!k) {
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      k = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      window.localStorage.setItem(KEY_SYNC, k);
    }
    return k;
  } catch {
    return null; // storage blocked — local-only, same as before
  }
}

/** Adopt a key from a bookmarked link, then pull that list down. */
export async function adoptKey(key: string): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_SYNC, key);
  } catch {
    return;
  }
  await pullRemote();
}

/** Push the local list up. Fire-and-forget: a failed sync must never block a
 *  save, it just means the backup is behind until the next toggle. */
function pushRemote(list: SavedProgram[]): void {
  const k = syncKey();
  if (!k) return;
  void fetch(`/api/saves/${k}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ programIds: list.map((e) => e.id) }),
  }).catch(() => {});
}

/** Pull the server list down and merge it in — used after adopting a key on a
 *  fresh browser. The server only stores ids, so recovered rows carry no name
 *  until the dossier fills it in; that is the cost of storing nothing personal. */
export async function pullRemote(): Promise<number> {
  const k = syncKey();
  if (!k) return 0;
  try {
    const res = await fetch(`/api/saves/${k}`);
    if (!res.ok) return 0;
    const { programIds } = (await res.json()) as { programIds?: string[] };
    if (!Array.isArray(programIds)) return 0;
    const have = new Set(readSaved().map((e) => e.id));
    const restored = programIds
      .filter((id) => !have.has(id))
      .map((id) => ({ id, name: null, category: null, savedAt: Date.now() }));
    if (restored.length) write([...readSaved(), ...restored]);
    return restored.length;
  } catch {
    return 0;
  }
}

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

function write(list: SavedProgram[], sync = true): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode or quota — the toggle still reflects in-memory state
  }
  if (sync) pushRemote(list);
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
