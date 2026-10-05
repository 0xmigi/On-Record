import { logger } from "@onrecord/core";
import { sweepSourceFramework } from "./source-framework.js";
import { requireDatabaseTarget } from "./db-target.js";

// ---------------------------------------------------------------------------
// Read framework-from-source for programs whose binary cannot name it (Quasar
// reads as Pinocchio) — see source-framework.ts. cron.ts runs a small batch
// every six hours; this walks the backlog by hand.
//
//   DATABASE_URL=… GITHUB_TOKEN=… tsx src/backfill-source-framework.ts [--dry] [--max=N] [--ids=a,b]
// ---------------------------------------------------------------------------

const dry = process.argv.includes("--dry");
const max = Number(process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 400);
const ids = process.argv.find((a) => a.startsWith("--ids="))?.split("=")[1]?.split(",").filter(Boolean);

const target = requireDatabaseTarget("backfill-source-framework.ts");
logger.info({ target, dry, max }, "source-framework: start");
const r = await sweepSourceFramework({ dry, max, verbose: true, ids });
logger.info({ ...r, dry }, "source-framework: done");
process.exit(0);
