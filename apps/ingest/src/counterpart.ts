import { eq } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  newId,
  stageLogger,
  findProgramAddress,
  getAccountBytes,
  getBlockTime,
  inspectProgramAccount,
  parseProgramDataAccount,
  getDeployHistory,
  LOADER_PROGRAM_ID,
  type ApiCounterpart,
  type Network,
} from "@onrecord/core";
import { classifyAuthority, inspectSquadsAuthority } from "@onrecord/enrich";

// ---------------------------------------------------------------------------
// Cross-cluster presence, probed at the address itself — and the promotion
// rule that follows from it.
//
// subjects.id is the program address alone, so a program deployed to BOTH
// clusters is one row and `network` was whichever cluster's upsert ran last.
// Last-writer-wins is the bug: a team that ships to mainnet and then keeps
// staging on devnet gets relabelled a devnet program by its own diligence. A
// dry run over the whole corpus (2026-08-12) put numbers on it:
//
//   mainnet rows also live on devnet   936 of 5,313  (17.6%)
//   devnet rows also live on mainnet   106 of 6,573  ( 1.6%)
//
// The second row is the broken one. 106 programs — Kamino Vault, 1Sol, Circuit
// Breaker, the GLAM set — sat on the devnet radar while running on mainnet.
//
// THE RULE: mainnet takes precedence. A program live on mainnet IS a mainnet
// program, whatever we saw last, and its devnet life is history rather than
// identity. So this module does two things:
//
//   1. probe   — is the same address live on the other cluster (a stored fact,
//                where absent and unknown stay distinct)
//   2. promote — a devnet-labelled subject found live on mainnet is re-ingested
//                FROM MAINNET, which flips the row and re-reads size, authority,
//                hash and upgrade count from the mainnet bytes. Its devnet life
//                is then written as the incubation fact the dossier already
//                renders as history.
//
// Promotion re-profiles rather than just flipping the label, because a row that
// claims mainnet while showing devnet bytes is worse than the bug it replaces.
//
// `incubation` alone could never have covered this: it is computed on a MAINNET
// event, so a program we have only ever seen on devnet never triggered it.
//
// Cost is bounded: 2 RPC calls for the common answer, +1 to classify an
// authority, +2 only when the authority looks like a vault PDA and the
// counterpart is mainnet — the case where "who can replace this" actually
// decides whether a claim is safe to publish.
// ---------------------------------------------------------------------------

const log = stageLogger("counterpart");

export function otherNetwork(network: Network): Network {
  return network === "mainnet" ? "devnet" : "mainnet";
}

function programDataAddress(programId: string): string {
  return bs58.encode(
    findProgramAddress([bs58.decode(programId)], bs58.decode(LOADER_PROGRAM_ID)),
  );
}

/** Probe the same address on the opposite cluster.
 *
 *  Returns a record with `present: false` when the address is genuinely empty
 *  there — that is an answer, and it is stored. Throws on RPC failure so the
 *  caller can leave the fact null (unknown) rather than writing a false absence. */
export async function probeCounterpart(
  network: Network,
  programId: string,
): Promise<ApiCounterpart> {
  const other = otherNetwork(network);
  const checkedAt = new Date().toISOString();
  const absent: ApiCounterpart = {
    network: other,
    present: false,
    alive: null,
    sizeBytes: null,
    deployedSlot: null,
    deployedAt: null,
    authority: null,
    authorityClass: null,
    checkedAt,
  };

  const account = await inspectProgramAccount(other, programId);
  if (account.kind === "absent") return absent;

  // Immutable (loader v1/v2) and native programs have no ProgramData to read.
  // They are present and unchangeable — say that rather than nothing.
  if (account.kind === "immutable") {
    return {
      ...absent,
      present: true,
      alive: true,
      sizeBytes: account.bytecode.length,
      authorityClass: "none",
    };
  }
  if (account.kind === "native") return { ...absent, present: true, alive: true, authorityClass: "none" };
  if (account.kind === "unrecognized") {
    // An account exists at the address but is not a program we can read. Not
    // present as a program — and not silently reported as one.
    return absent;
  }

  const bytes = await getAccountBytes(other, account.programDataAddress);
  // parseProgramDataAccount, NOT parseProgramDataHeader: sizeBytes has to be
  // the BYTECODE length (header stripped, trailing zero padding trimmed) so it
  // is comparable with subjects.sizeBytes, which the fingerprint stage sets
  // from the same parse. Using the raw account length here made every
  // dual-cluster program look like it was running two different builds — the
  // account is padded to the deploy's --max-len, the bytecode is not.
  const parsed = bytes ? parseProgramDataAccount(bytes) : null;
  if (!parsed) {
    // The Program account points at a ProgramData that is gone or is a husk:
    // the program was closed on that cluster. Present, but not alive.
    return { ...absent, present: true, alive: false };
  }

  let authorityClass = parsed.upgradeAuthority
    ? await classifyAuthority(other, parsed.upgradeAuthority)
    : ("none" as const);

  // Squads hides behind a vault PDA, which classifies as "program". On mainnet
  // that distinction is the whole point of this probe — a devnet hot wallet and
  // a mainnet multisig on the same program id are not the same fact.
  if (other === "mainnet" && (authorityClass === "program" || authorityClass === "squads")) {
    const dh = await getDeployHistory(other, account.programDataAddress).catch(() => null);
    if (dh?.lastSignature) {
      const multisig = await inspectSquadsAuthority(other, dh.lastSignature);
      if (multisig) authorityClass = "squads";
    }
  }

  const blockTime = await getBlockTime(other, parsed.deployedSlot).catch(() => null);

  return {
    network: other,
    present: true,
    alive: true,
    sizeBytes: parsed.bytecode.length,
    deployedSlot: parsed.deployedSlot,
    deployedAt: blockTime ? new Date(blockTime * 1000).toISOString() : null,
    authority: parsed.upgradeAuthority,
    authorityClass,
    checkedAt,
  };
}

/** Probe and persist onto subjects.facts.counterpart. Never throws — a failed
 *  probe leaves the existing fact (or null) alone, because "we could not reach
 *  the other cluster" must not be written down as "it is not there".
 *
 *  When a devnet-labelled subject turns out to be live on mainnet, this also
 *  promotes it (see promoteToMainnet). Pass `{ promote: false }` to probe only.
 *
 *  `network` is the caller's idea of where this program lives; the SUBJECT ROW
 *  is what actually decides. They diverge in two real cases — a devnet upgrade
 *  event arriving for a program that has since been promoted to mainnet, and a
 *  backfill loop holding the network it read before promotion ran — and using
 *  the caller's value would write a mainnet-pointing counterpart onto a mainnet
 *  row, i.e. "also on mainnet" on a mainnet page. Whatever else this module
 *  gets wrong, the counterpart must be the OTHER cluster. */
export async function recordCounterpart(
  network: Network,
  programId: string,
  opts: { promote?: boolean } = {},
): Promise<ApiCounterpart | null> {
  const rows = await db
    .select({ facts: schema.subjects.facts, network: schema.subjects.network })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, programId));
  const subject = rows[0];
  const home = (subject?.network as Network | undefined) ?? network;

  let probe: ApiCounterpart;
  try {
    probe = await probeCounterpart(home, programId);
  } catch (err) {
    log.warn({ programId, home, err: String(err) }, "counterpart probe failed — leaving unknown");
    return null;
  }

  if (!subject) return probe;

  await db
    .update(schema.subjects)
    .set({
      facts: { ...(subject.facts ?? {}), counterpart: probe },
      updatedAt: new Date(),
    })
    .where(eq(schema.subjects.id, programId));

  if (probe.present) {
    log.info(
      { programId, other: probe.network, authorityClass: probe.authorityClass },
      "also live on the other cluster",
    );
  }

  // Mainnet takes precedence. A devnet row that is live on mainnet is a mainnet
  // program whose devnet life is history — promote it rather than leaving it on
  // the wrong radar. `alive === false` (closed there) does not qualify: a
  // reclaimed mainnet deployment is history too, and the devnet one is what is
  // actually running.
  if (opts.promote !== false && home === "devnet" && probe.present && probe.alive !== false) {
    await promoteToMainnet(programId);
  }
  return probe;
}

/** Re-ingest a devnet-labelled subject from mainnet, then record its devnet
 *  life as history.
 *
 *  Runs the ordinary pipeline stages against a synthetic mainnet deploy event,
 *  so the subject upsert refreshes network, size, sha256, authority and upgrade
 *  count from the MAINNET ProgramData — the row ends up describing the
 *  deployment that matters, not the one we happened to poll last.
 *
 *  Re-entrancy is bounded at one level: the mainnet event's own classify stage
 *  calls recordCounterpart('mainnet', …), which cannot promote (its home is
 *  already mainnet) and therefore terminates. */
export async function promoteToMainnet(programId: string): Promise<boolean> {
  const pd = programDataAddress(programId);
  try {
    const raw = await getAccountBytes("mainnet", pd);
    const parsed = raw ? parseProgramDataAccount(raw) : null;
    if (!parsed) {
      log.warn({ programId }, "promote: no mainnet ProgramData — leaving on devnet");
      return false;
    }
    const dh = await getDeployHistory("mainnet", pd);

    const eventId = newId("evt");
    const inserted = await db
      .insert(schema.events)
      .values({
        id: eventId,
        network: "mainnet",
        type: "deploy",
        // Deterministic, and namespaced so it is never mistaken for a real
        // signature: this event is a record-keeping artefact, not a sighting.
        signature: `counterpart-promote:${pd}`,
        instructionIndex: 0,
        slot: dh.firstDeploySlot ?? dh.lastDeploySlot ?? 0,
        blockTime: dh.firstDeployAt ?? new Date(),
        programId,
        programDataAddress: pd,
        authorityBefore: null,
        authorityAfter: parsed.upgradeAuthority ?? null,
      })
      .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
      .returning({ id: schema.events.id });

    const evId = inserted[0]?.id;
    if (!evId) {
      log.info({ programId }, "promote: mainnet event already on record");
      return false;
    }

    const { fingerprintStage, identifyStage, classifyStage, scoreStage } = await import(
      "./pipeline.js"
    );
    await fingerprintStage(evId);
    await identifyStage(evId);
    await classifyStage(evId);
    await scoreStage(evId);

    // The devnet life becomes history. linkIncubation matches on the program id
    // itself, which is exactly the relationship we just proved by probing.
    const { linkIncubation } = await import("./incubation.js");
    await linkIncubation(programId, dh.firstDeployAt, { probeChain: true });

    log.info({ programId, mainnetFirstDeploy: dh.firstDeployAt }, "promoted to mainnet");
    return true;
  } catch (err) {
    log.error({ programId, err: String(err) }, "promote failed — subject left as it was");
    return false;
  }
}
