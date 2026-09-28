import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// ed25519 on-curve check and PDA derivation, with bigint field math: no
// dependencies, so the verify doctor (and the CLI built on it) can derive
// addresses without pulling in the rest of core.
// ---------------------------------------------------------------------------

const P = 2n ** 255n - 19n;
const D = mod(-121665n * inverse(121666n));

function mod(n: number | bigint): bigint {
  const r = BigInt(n) % P;
  return r < 0n ? r + P : r;
}

function power(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function inverse(n: bigint): bigint {
  return power(n, P - 2n);
}

const SQRT_M1 = power(2n, (P - 1n) / 4n);

/** True if the 32-byte compressed point decodes to a point on ed25519. */
export function isOnCurve(pubkey: Uint8Array): boolean {
  if (pubkey.length !== 32) return false;
  const bytes = Buffer.from(pubkey);
  const yBytes = Buffer.from(bytes);
  yBytes[31]! &= 0x7f;
  const y = BigInt("0x" + Buffer.from(yBytes).reverse().toString("hex"));
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // candidate sqrt of u/v for p ≡ 5 (mod 8): x = u·v³·(u·v⁷)^((p−5)/8)  (RFC 8032)
  let x = (((u * power(v, 3n)) % P) * power((u * power(v, 7n)) % P, (P - 5n) / 8n)) % P;
  const vx2 = (v * x * x) % P;
  if (vx2 === u) {
    // ok
  } else if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P;
  } else {
    return false;
  }
  if (x === 0n && (bytes[31]! & 0x80) !== 0) return false;
  return true;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "ascii");

export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(...seeds, Buffer.from([bump]), programId, PDA_MARKER);
    if (!isOnCurve(candidate)) return candidate;
  }
  throw new Error("no viable PDA bump");
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
