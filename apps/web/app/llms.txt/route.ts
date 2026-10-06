/**
 * /llms.txt — what On Record is and how to read it, for AI assistants
 * (llmstxt.org). Kept to what the site itself states; the methodology page is
 * the source for anything about scoring.
 */
export const dynamic = "force-static";

const SITE = "https://on-record.azuolas.xyz";

const BODY = `# On Record

> A radar for Solana programs. On Record watches every program deployed or upgraded on Solana mainnet (and devnet) and records what each one is, where its code came from, who controls it, and whether it still matches its published source.

Most programs on Solana are opaque: no name, no source repo, no IDL. On Record reads the deployed bytecode itself and recovers what it gives up: the Rust crate name and source file tree (from panic paths, which survive release builds), the syscalls it imports, its instructions, and how closely it resembles every other program on record. It also records the upgrade authority (including Squads multisig thresholds), the deploy and upgrade history, verified-build status, security.txt and Program Metadata, and sampled transaction activity.

## Reading a program

- Program page: ${SITE}/p/<program id> — one page per program address.
- Plain-text version: ${SITE}/p/<program id>/dossier.md — the same program as markdown, written to be quoted accurately. Every line states how it was derived, comparisons are relative to the rest of the corpus rather than absolute, and absent, zero and unknown are kept distinct. It has an explicit section on what is not known. Prefer it over the HTML page.

## Conventions worth knowing

- "Upgrade" means the program id already existed; it is not a new program.
- "Verified" means a reproducible build was matched to public source (OtterSec verification). Unverified is not the same as malicious.
- Novelty bands compare bytecode against everything on record: novel (nothing similar), variant (loosely similar), clone (a fork or near-identical redeploy).
- In the plain-text version, traffic comes from sampled, parsed transactions and is stamped with when it was sampled. It is a sample, not a count.

## Pages

- [Verification alerts](${SITE}/verification): sign up with a deploy or upgrade-authority address and get a message when a mainnet upgrade leaves a program unverified, with the reason and the fix.
- [Writing](${SITE}/writing): articles on building Solana programs. First: [Where are the verified builds on Solana?](${SITE}/writing/verified-builds), on why only 1 in 40 live Solana programs has a verified build and how to keep one (figures from 28 Sep 2026).
- [Radar](${SITE}/): programs deployed and upgraded recently, ranked.
- [Methodology](${SITE}/methodology): how programs are scored and ranked, and the syscall rarity tiers.
- [Stats](${SITE}/funnel): stats on every program deployed to Solana, over a time window.
`;

export function GET() {
  return new Response(BODY, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
