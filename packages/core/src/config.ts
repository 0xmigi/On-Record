import { eq } from "drizzle-orm";
import { db, schema } from "./db/client.js";
import { DEFAULT_CONFIG, type RuntimeConfig } from "./types.js";

// Env config — required secrets and endpoints (spec §7)
export const env = {
  HELIUS_API_KEY: process.env.HELIUS_API_KEY ?? "",
  HELIUS_WEBHOOK_SECRET_MAINNET: process.env.HELIUS_WEBHOOK_SECRET_MAINNET ?? "",
  HELIUS_WEBHOOK_SECRET_DEVNET: process.env.HELIUS_WEBHOOK_SECRET_DEVNET ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  WRITER_MODEL: process.env.WRITER_MODEL ?? "claude-sonnet-4-6",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  PORT: Number(process.env.PORT ?? 3001),
  PUBLIC_API_URL: process.env.PUBLIC_API_URL ?? "http://localhost:3001",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
};

const CONFIG_KEY = "runtime";
let cache: { value: RuntimeConfig; at: number } | null = null;
const CACHE_MS = 30_000;

/** Runtime config lives in the config table so operators can tune thresholds
 *  without a redeploy. Cached for 30s per process. */
export async function getConfig(): Promise<RuntimeConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await db.select().from(schema.config).where(eq(schema.config.key, CONFIG_KEY));
  const stored = (rows[0]?.value ?? {}) as Partial<RuntimeConfig>;
  const merged: RuntimeConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    rankWeights: { ...DEFAULT_CONFIG.rankWeights, ...(stored.rankWeights ?? {}) },
    perTypeFloors: { ...DEFAULT_CONFIG.perTypeFloors, ...(stored.perTypeFloors ?? {}) },
  };
  cache = { value: merged, at: Date.now() };
  return merged;
}

export async function updateConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
  const current = await getConfig();
  const next = {
    ...current,
    ...patch,
    rankWeights: { ...current.rankWeights, ...(patch.rankWeights ?? {}) },
    perTypeFloors: { ...current.perTypeFloors, ...(patch.perTypeFloors ?? {}) },
  };
  await db
    .insert(schema.config)
    .values({ key: CONFIG_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.config.key, set: { value: next, updatedAt: new Date() } });
  cache = { value: next, at: Date.now() };
  return next;
}
