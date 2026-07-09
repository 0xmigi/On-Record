// ---------------------------------------------------------------------------
// Fuzzy code-similarity via bottom-k MinHash over byte-shingles (docs/GRADING.md
// §5 step 2). Measures how much *code* two programs share — robust to renames,
// build-path noise, and recompiles (a few differing shingles among thousands
// barely move the estimate). This is the basis of the real novelty definition:
// novelty = 1 − similarity to the nearest known program.
// ---------------------------------------------------------------------------

const K = 128; // signature size
const SHINGLE = 8; // window bytes

/** FNV-1a 32-bit over an 8-byte window. */
function shingleHash(data: Buffer, i: number): number {
  let h = 0x811c9dc5;
  for (let j = 0; j < SHINGLE; j++) {
    h ^= data[i + j]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Bottom-k MinHash signature: the k smallest distinct shingle hashes, sorted.
 *  Memory is bounded by periodic pruning, so megabyte programs are cheap. */
export function minhashSignature(data: Buffer): number[] {
  if (data.length < SHINGLE) return [];
  const seen = new Set<number>();
  let buf: number[] = [];
  let threshold = 0xffffffff;
  const cap = K * 4;
  for (let i = 0; i + SHINGLE <= data.length; i++) {
    const h = shingleHash(data, i);
    if (h <= threshold && !seen.has(h)) {
      seen.add(h);
      buf.push(h);
      if (buf.length >= cap) {
        buf.sort((a, b) => a - b);
        buf = buf.slice(0, K);
        threshold = buf[buf.length - 1]!;
        seen.clear();
        for (const v of buf) seen.add(v);
      }
    }
  }
  buf.sort((a, b) => a - b);
  return buf.slice(0, K);
}

/** Bottom-k Jaccard estimate of two signatures (both sorted ascending). */
export function minhashSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const k = Math.min(a.length, b.length, K);
  const sa = new Set(a);
  const sb = new Set(b);
  // smallest k of the union
  const union: number[] = [];
  let i = 0;
  let j = 0;
  let last = -1;
  while (union.length < k && (i < a.length || j < b.length)) {
    let v: number;
    if (j >= b.length || (i < a.length && a[i]! <= b[j]!)) v = a[i++]!;
    else v = b[j++]!;
    if (v === last) continue; // dedupe
    last = v;
    union.push(v);
  }
  let inter = 0;
  for (const v of union) if (sa.has(v) && sb.has(v)) inter++;
  return inter / union.length;
}
