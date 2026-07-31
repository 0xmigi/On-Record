import { NextResponse } from "next/server";

// Thin proxy to the record API's saved-list endpoints.
//
// The sync runs in the browser, but the API's base URL is a server-side env var
// (API_URL) — exposing it as NEXT_PUBLIC_ just to let the client call it
// directly would mean a second source of truth for the same address and a CORS
// surface for no reason. Forwarding keeps the client on a relative path.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";

export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/saves/${encodeURIComponent(key)}`, {
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    // the backup being unreachable must never look like an empty list
    return NextResponse.json({ error: "sync unavailable" }, { status: 502 });
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/saves/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: await req.text(),
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "sync unavailable" }, { status: 502 });
  }
}
