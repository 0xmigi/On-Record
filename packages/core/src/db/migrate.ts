import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url = process.env.DATABASE_URL ?? "postgres://onrecord:onrecord@localhost:5432/onrecord";
const client = postgres(url, { max: 1 });
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

await migrate(drizzle(client), { migrationsFolder: dir });
await client.end();
console.log("migrations applied");
