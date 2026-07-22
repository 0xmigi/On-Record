import { NextResponse } from "next/server";
import { fetchSearch, type Network } from "@/lib/api";

// The typeahead runs in the browser, but API_URL is a server-only env var —
// this thin proxy is what lets the client query without exposing the backend.
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const network = searchParams.get("network");
  const result = await fetchSearch(q, {
    network: network === "devnet" || network === "mainnet" ? (network as Network) : undefined,
    limit: Number(searchParams.get("limit")) || 8,
    sort: searchParams.get("sort") === "recent" ? "recent" : "relevance",
  });
  return NextResponse.json(result, {
    // identical keystrokes are common (backspace, retype) — a short shared
    // cache absorbs them without staling the index meaningfully
    headers: { "Cache-Control": "public, max-age=15" },
  });
}
