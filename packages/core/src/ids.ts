import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // crockford-ish, no lookalikes

/** Sortable-enough short id: ms timestamp base32 + 10 random chars. */
export function newId(prefix: string): string {
  const time = Date.now().toString(32);
  const rand = Array.from(randomBytes(10), (b) => ALPHABET[b % 32]).join("");
  return `${prefix}_${time}${rand}`;
}
