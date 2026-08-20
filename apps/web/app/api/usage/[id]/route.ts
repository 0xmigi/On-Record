import { NextResponse } from "next/server";

// Thin proxy to the record API's usage-fill endpoint.
//
// POST only, and that is the point. The backend measures a program's usage here
// — the one unauthenticated path that spends Helius credits — so it must be
// unreachable by anything that merely *renders* a page. Next.js prefetches a
// link by server-rendering its route, which is a GET; a crawler is a GET. Only
// the client effect in UsageSection.tsx, after a real navigation, sends this.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/programs/${encodeURIComponent(id)}/usage`, {
      method: "POST",
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    // the section simply stays as it was rendered — never a broken page
    return NextResponse.json({ usage: null, sampledAt: null, measured: false }, { status: 502 });
  }
}
