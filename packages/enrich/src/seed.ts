import { logger } from "@onrecord/core";
import { seedFromDefiLlama, seedFromLabels } from "./entities.js";

const labels = await seedFromLabels();
logger.info({ labels }, "seeded entities from labels.yaml");

try {
  const llama = await seedFromDefiLlama();
  logger.info({ llama }, "seeded entities from DeFiLlama");
} catch (err) {
  logger.warn({ err: String(err) }, "DeFiLlama seed failed (offline?) — labels-only registry");
}

process.exit(0);
