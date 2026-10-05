import { logger, type Network } from "@onrecord/core";
import { syncPmpSecurity } from "./pmp-security-sync.js";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";

// ---------------------------------------------------------------------------
// Run the PMP security sync by hand (cron.ts runs it daily — see
// pmp-security-sync.ts for why it exists and what it costs).
//
//   DATABASE_URL=… HELIUS_API_KEY=… tsx src/backfill-pmp-security.ts [--network=mainnet|devnet] [--dry]
//
// --dry prints every row it would change — and which of them would start (or
// stop) counting as a security.txt — and writes nothing.
// ---------------------------------------------------------------------------

const dry = process.argv.includes("--dry");
const only = process.argv.find((a) => a.startsWith("--network="))?.split("=")[1] as Network | undefined;

const target = requireDatabaseTarget("backfill-pmp-security.ts");
requireRpcKey("backfill-pmp-security.ts");
logger.info({ target, dry }, "pmp-security: start");
for (const network of only ? [only] : (["mainnet", "devnet"] as Network[])) {
  await syncPmpSecurity(network, { dry, verbose: true });
}
process.exit(0);
