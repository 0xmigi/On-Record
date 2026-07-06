import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgres://onrecord:onrecord@localhost:5432/onrecord";

// One shared pool per process. max kept modest — this runs on a single box.
const client = postgres(url, { max: 10 });

export const db = drizzle(client, { schema });
export type Db = typeof db;
export { schema };
