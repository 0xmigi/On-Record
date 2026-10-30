/**
 * Whether a Solana address is a point on the ed25519 curve. An address on the
 * curve has a private key: a wallet. One off it is a program-derived address,
 * which only a program can sign for (a multisig vault, a program's own PDA).
 * Same test as Solana's `PublicKey.isOnCurve`, written out so the page doesn't
 * pull in a Solana SDK for one check.
 */

// BigInt() calls, not 1n literals: the app compiles to ES2017
const B = BigInt;
const P = (B(1) << B(255)) - B(19);
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function pow(b: bigint, e: bigint): bigint {
  let r = B(1);
  b %= P;
  while (e > B(0)) {
    if (e & B(1)) r = (r * b) % P;
    b = (b * b) % P;
    e >>= B(1);
  }
  return r;
}

const inv = (x: bigint) => pow(x, P - B(2));
const mod = (x: bigint) => ((x % P) + P) % P;
const D = mod(-B(121665) * inv(B(121666)));

/** base58 to bytes; null when it isn't 32 bytes of base58 */
function decode(address: string): Uint8Array | null {
  let n = B(0);
  for (const c of address) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * B(58) + B(i);
  }
  const bytes: number[] = [];
  for (; n > B(0); n >>= B(8)) bytes.unshift(Number(n & B(255)));
  for (const c of address) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return bytes.length === 32 ? Uint8Array.from(bytes) : null;
}

/** true for a wallet, false for a PDA, null when it isn't an address */
export function isOnCurve(address: string): boolean | null {
  const b = decode(address);
  if (!b) return null;
  // little-endian y, top bit is x's sign
  let y = B(0);
  for (let i = 31; i >= 0; i--) y = (y << B(8)) | B(b[i]!);
  const sign = y >> B(255);
  y &= (B(1) << B(255)) - B(1);
  if (y >= P) return false;
  const yy = (y * y) % P;
  const xx = mod((yy - B(1)) * inv(D * yy + B(1)));
  if (xx === B(0)) return sign === B(0);
  // x² has a square root only when it's a quadratic residue
  return pow(xx, (P - B(1)) / B(2)) === B(1);
}
