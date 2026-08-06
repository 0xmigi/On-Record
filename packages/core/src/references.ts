import { base58Decode } from "./profile.js";

// ---------------------------------------------------------------------------
// Program references — which programs a binary names.
//
// The profiler already answers a narrow version of this: it base58-decodes a
// hardcoded table of ~15 well-known ids and asks whether each 32-byte sequence
// appears in the image ("TALKS TO Metaplex Metadata"). That dictionary is the
// only limit. A program id is a 32-byte constant, and a program that CPIs into
// another almost always carries the callee's id as one — `declare_id!`,
// `pubkey!`, or a plain [u8; 32] in .rodata.
//
// So this inverts the search. Instead of hunting a short list of needles in the
// haystack, index the WHOLE corpus by the first four bytes of each id and walk
// the image once, testing every offset against that index. What falls out is
// the edge list: kvault names klend, a fork names what it forked.
//
// Cost is one map lookup per byte offset, and a full 32-byte compare only on a
// 4-byte prefix hit (~1 spurious hit per image at corpus scale, all rejected by
// the compare). A 500 KB program against a 10k-id index is a few milliseconds.
//
// WHAT THIS IS NOT: proof of a call. An embedded id proves the binary NAMES
// another program, which is why the edge is called a reference. Most references
// are callees, but a program can also hold an id it merely validates against,
// and a callee passed in as a runtime account leaves no constant behind at all
// — so the graph under-reports rather than over-reports. Anything stronger has
// to come from observed transactions.
// ---------------------------------------------------------------------------

export interface PubkeyIndex {
  /** first 4 bytes (LE uint32) → candidates sharing that prefix */
  byPrefix: Map<number, { bytes: Buffer; id: string }[]>;
  size: number;
}

/** Index a set of base58 program ids for scanning. Ids that aren't 32 bytes are
 *  dropped rather than throwing — the corpus holds whatever the chain gave us. */
export function buildPubkeyIndex(ids: Iterable<string>): PubkeyIndex {
  const byPrefix = new Map<number, { bytes: Buffer; id: string }[]>();
  let size = 0;
  for (const id of ids) {
    const bytes = base58Decode(id);
    if (!bytes || bytes.length !== 32) continue;
    const key = bytes.readUInt32LE(0);
    const bucket = byPrefix.get(key);
    if (bucket) bucket.push({ bytes, id });
    else byPrefix.set(key, [{ bytes, id }]);
    size++;
  }
  return { byPrefix, size };
}

/** Every indexed program id whose 32 bytes appear in this image.
 *
 *  `self` is excluded: essentially every program carries its own id from
 *  `declare_id!`, and an edge from a program to itself is noise on every row. */
export function findReferencedPrograms(
  bytecode: Buffer,
  index: PubkeyIndex,
  opts: { self?: string } = {},
): string[] {
  const hits = new Set<string>();
  const end = bytecode.length - 32;
  for (let off = 0; off <= end; off++) {
    const candidates = index.byPrefix.get(bytecode.readUInt32LE(off));
    if (!candidates) continue;
    for (const c of candidates) {
      if (hits.has(c.id)) continue;
      if (bytecode.compare(c.bytes, 0, 32, off, off + 32) === 0) hits.add(c.id);
    }
  }
  if (opts.self) hits.delete(opts.self);
  return [...hits].sort();
}
