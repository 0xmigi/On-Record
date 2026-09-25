import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Everything the doctor reads from chain: the program, its ProgramData, and
// the verification uploads (otter-verify PDAs) that point at it. Plain JSON-RPC
// over fetch, so it needs no dependencies and works against any RPC —
// the public endpoint handles every call here, getProgramAccounts included,
// because the lookup is filtered to one program.
// ---------------------------------------------------------------------------

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const OTTER_VERIFY_PROGRAM = "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC";
/** Uploads signed by OtterSec itself rather than the program's team
 *  (solana-verify's `OTTER_SIGNER`). */
export const OTTER_SIGNER = "9VWiUUhgNoRwTH5NVehYJEDwcotwYX3VgW4MChiHPAqU";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

const LOADER_NAMES: Record<string, string> = {
  BPFLoader1111111111111111111111111111111111: "the original BPF loader",
  BPFLoader2111111111111111111111111111111111: "BPF loader v2",
  LoaderV411111111111111111111111111111111111: "loader v4",
  NativeLoader1111111111111111111111111111111: "the native loader",
};

/** ProgramData: u32 tag · u64 slot · Option<Pubkey> authority (1 + 32). */
const PROGRAMDATA_HEADER = 45;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A Solana address decodes to exactly 32 bytes. */
export function isAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  let len = 0;
  while (n > 0n) {
    n /= 256n;
    len++;
  }
  for (const c of s) {
    if (c !== "1") break;
    len++;
  }
  return len === 32;
}

export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export function rpcClient(url: string): Rpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        // dropped connections and timeouts are worth a second try
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
          continue;
        }
        throw new Error(`RPC ${method}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // the public endpoint rate-limits bursts; back off rather than fail
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) throw new Error(`RPC ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
      return json.result as T;
    }
  };
}

interface AccountInfo {
  owner: string;
  executable: boolean;
  data: [string, string];
}

async function getAccount(rpc: Rpc, address: string): Promise<{ owner: string; executable: boolean; data: Buffer } | null> {
  const res = await rpc<{ value: AccountInfo | null }>("getAccountInfo", [address, { encoding: "base64" }]);
  if (!res.value) return null;
  return { owner: res.value.owner, executable: res.value.executable, data: Buffer.from(res.value.data[0], "base64") };
}

export interface SecurityTxt {
  name?: string;
  projectUrl?: string;
  sourceCode?: string;
  sourceRevision?: string;
}

export interface ProgramFacts {
  programData: string;
  /** Slot of the last deploy or upgrade, from the ProgramData header. */
  deploySlot: number;
  deployedAt: string | null;
  /** null = immutable (upgrade authority removed). */
  authority: string | null;
  sizeBytes: number;
  /** Same digest solana-verify prints: sha256 of the ELF with trailing zero
   *  padding stripped. */
  hash: string;
  securityTxt: SecurityTxt | null;
}

export type ProgramRead = { ok: true; program: ProgramFacts } | { ok: false; problem: string };

export async function readProgram(rpc: Rpc, programId: string): Promise<ProgramRead> {
  const account = await getAccount(rpc, programId);
  if (!account) return { ok: false, problem: "No account exists at this address on this cluster." };
  if (account.owner !== UPGRADEABLE_LOADER) {
    const loader = LOADER_NAMES[account.owner];
    return {
      ok: false,
      problem: loader
        ? `This program was deployed with ${loader}. The doctor only reads upgradeable-loader programs so far.`
        : `This address is not a program (owned by ${account.owner}).`,
    };
  }
  // Program account: u32 tag (2) · ProgramData address
  if (account.data.length < 36) return { ok: false, problem: "This is a ProgramData or buffer account, not a program id." };
  const programData = b58encode(account.data.subarray(4, 36));
  const pd = await getAccount(rpc, programData);
  if (!pd) return { ok: false, problem: "This program has been closed: its ProgramData account no longer exists." };

  const deploySlot = Number(pd.data.readBigUInt64LE(4));
  const authority = pd.data[12] === 1 ? b58encode(pd.data.subarray(13, 45)) : null;
  let end = pd.data.length;
  while (end > PROGRAMDATA_HEADER && pd.data[end - 1] === 0) end--;
  const elf = pd.data.subarray(PROGRAMDATA_HEADER, end);

  let deployedAt: string | null = null;
  try {
    const t = await rpc<number | null>("getBlockTime", [deploySlot]);
    if (t) deployedAt = new Date(t * 1000).toISOString();
  } catch {
    // old slots can fall outside the node's ledger; the slot alone still works
  }

  return {
    ok: true,
    program: {
      programData,
      deploySlot,
      deployedAt,
      authority,
      sizeBytes: elf.length,
      hash: createHash("sha256").update(elf).digest("hex"),
      securityTxt: readSecurityTxt(elf),
    },
  };
}

/** The security.txt convention embeds null-separated key/value pairs between
 *  two markers in the ELF. */
function readSecurityTxt(elf: Buffer): SecurityTxt | null {
  const begin = elf.indexOf("=======BEGIN SECURITY.TXT V1=======\0");
  if (begin < 0) return null;
  const end = elf.indexOf("=======END SECURITY.TXT V1=======", begin);
  if (end < 0) return null;
  const parts = elf.subarray(begin, end).toString("utf8").split("\0").slice(1);
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) fields[parts[i]!] = parts[i + 1]!;
  return {
    name: fields.name,
    projectUrl: fields.project_url,
    sourceCode: fields.source_code,
    sourceRevision: fields.source_revision,
  };
}

export interface Upload {
  pda: string;
  signer: string;
  cliVersion: string;
  gitUrl: string;
  commit: string;
  args: string[];
  /** The program's deploy slot when the recipe was uploaded. Older uploads
   *  predate the field; for those we fall back to lastWriteSlot. */
  deployedSlot: number | null;
  lastWriteSlot: number | null;
}

/** Every otter-verify upload for this program, one per signer. The account is
 *  OtterBuildParams (Anchor/borsh): discriminator 8 · address 32 · signer 32 ·
 *  version · git_url · commit (strings) · args (Vec<String>) · deployed_slot u64. */
export async function readUploads(rpc: Rpc, programId: string): Promise<Upload[]> {
  const accounts = await rpc<{ pubkey: string; account: AccountInfo }[]>("getProgramAccounts", [
    OTTER_VERIFY_PROGRAM,
    { encoding: "base64", filters: [{ memcmp: { offset: 8, bytes: programId } }] },
  ]);
  const uploads: Upload[] = [];
  for (const { pubkey, account } of accounts) {
    const d = Buffer.from(account.data[0], "base64");
    if (d.length < 72) continue;
    let o = 72;
    const str = (): string => {
      const n = d.readUInt32LE(o);
      o += 4;
      const s = d.subarray(o, o + n).toString("utf8");
      o += n;
      return s;
    };
    const upload: Upload = {
      pda: pubkey,
      signer: b58encode(d.subarray(40, 72)),
      cliVersion: "",
      gitUrl: "",
      commit: "",
      args: [],
      deployedSlot: null,
      lastWriteSlot: null,
    };
    try {
      upload.cliVersion = str();
      upload.gitUrl = str();
      // some older uploads stored a literal "None" instead of leaving it empty
      const commit = str();
      upload.commit = /^(none|null)$/i.test(commit) ? "" : commit;
      const count = d.readUInt32LE(o);
      o += 4;
      for (let i = 0; i < count; i++) upload.args.push(str());
      const slot = Number(d.readBigUInt64LE(o));
      if (slot > 0) upload.deployedSlot = slot;
    } catch {
      // truncated: an older layout without args or deployed_slot
    }
    if (upload.deployedSlot === null) {
      const sigs = await rpc<{ slot: number }[]>("getSignaturesForAddress", [pubkey, { limit: 1 }]);
      upload.lastWriteSlot = sigs[0]?.slot ?? null;
    }
    uploads.push(upload);
  }
  return uploads;
}

export async function isMainnet(rpc: Rpc): Promise<boolean> {
  return (await rpc<string>("getGenesisHash", [])) === MAINNET_GENESIS;
}
