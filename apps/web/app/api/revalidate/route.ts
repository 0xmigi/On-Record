import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

/**
 * The API calls this when a program's record changes — a deploy, upgrade,
 * authority change, close, or verification result — so its cached dossier is
 * rebuilt now instead of at the end of its cache window (app/p/[id]/page.tsx).
 * Sender: apps/ingest/src/revalidate.ts.
 */
const SECRET = process.env.REVALIDATE_SECRET ?? "";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_IDS = 100;

function authorised(given: string | null): boolean {
  if (!SECRET || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorised(req.headers.get("x-revalidate-secret"))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && ADDRESS.test(v)).slice(0, MAX_IDS)
    : [];
  // the page and the data it was built from: revalidatePath also expires the
  // fetches made while rendering that path
  for (const id of ids) {
    revalidatePath(`/p/${id}`);
    revalidatePath(`/p/${id}/dossier.md`);
  }
  return NextResponse.json({ revalidated: ids.length });
}
