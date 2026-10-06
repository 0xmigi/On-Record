import { NextResponse } from "next/server";

// Thin proxy to the record API's verification-alert endpoints, for the same
// reason as /api/saves: the browser stays on a relative path and API_URL stays
// server-side. Only the four alert actions pass; nothing else is reachable.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";
const GETS = new Set(["programs", "subscription"]);
const POSTS = new Set(["subscribe", "unsubscribe"]);

async function forward(url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "alerts unavailable, try again shortly" }, { status: 502 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!GETS.has(action)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const qs = new URL(req.url).search;
  return forward(`${API_BASE}/api/alerts/${action}${qs}`, {});
}

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!POSTS.has(action)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return forward(`${API_BASE}/api/alerts/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // the API rate-limits sign-ups per caller
      "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "",
    },
    body: await req.text(),
  });
}
