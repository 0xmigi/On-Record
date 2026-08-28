import { NextResponse } from "next/server";

// Thin proxy to the record API's compute-fill endpoint.
//
// POST only, for the same reason the usage proxy is POST: the backend takes a
// metered reading here (one getTransaction per sampled signature), so it must
// be unreachable by anything that merely *renders* a page. Next.js prefetches a
// link by server-rendering its route, which is a GET; a crawler is a GET. Only
// the client effect in ComputeProfile.tsx, after a real navigation, sends this.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/programs/${encodeURIComponent(id)}/compute`, {
      method: "POST",
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    // the section stays as it was rendered — never a broken page
    return NextResponse.json(
      { compute: null, computeRank: null, measured: false, reason: "failed" },
      { status: 502 },
    );
  }
}
