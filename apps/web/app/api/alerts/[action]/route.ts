import { NextResponse } from "next/server";

// Thin proxy to the record API's verification-alert endpoints, for the same
// reason as /api/saves: the browser stays on a relative path and API_URL stays
// server-side. Only the four alert actions pass, plus "check" (one program's
// verification checklist, for /verification); nothing else is reachable.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";
const GETS = new Set(["programs", "subscription"]);
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POSTS = new Set(["subscribe", "unsubscribe"]);

async function forward(url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, cache: "no-store" });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "alerts unavailable, try again shortly" }, { status: 502 });
  }
}

/** what the program's own page leaves out of the sign-up's guide */
const HEAVY = ["events", "neighbors", "strings", "idlInstructions", "syscalls", "instructionNames", "sourceKin", "references", "similarityTo"];

/** Whether the source a program declares is public: GitHub answers 404 to
 *  anyone outside a private repo, the same answer OtterSec's builder gets.
 *  The URL came out of the binary, so only an owner/repo we rebuild ourselves
 *  is fetched. null when it isn't on GitHub or GitHub didn't answer. */
async function publicOnGitHub(url: unknown): Promise<boolean | null> {
  if (typeof url !== "string") return null;
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!m) return null;
  try {
    const res = await fetch(`https://github.com/${m[1]}/${m[2]}`, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
      next: { revalidate: 3600 },
    });
    return res.ok ? true : res.status === 404 ? false : null;
  } catch {
    return null;
  }
}

/** One program for the /verification guide: the record (for its card, its
 *  authority and the machine its bytes say built it) plus the verify doctor's
 *  verdict, mainnet only. A cold doctor answers 503 while it keeps going, so
 *  the guide shows "checking" and asks again. */
async function check(id: string) {
  try {
    // both at once: the record is the slow half, the doctor answers within its deadline
    const [res, v] = await Promise.all([
      fetch(`${API_BASE}/api/programs/${id}`, { cache: "no-store" }),
      fetch(`${API_BASE}/api/programs/${id}/verification`, { cache: "no-store" }),
    ]);
    if (res.status === 404) return NextResponse.json({ error: "not on record" }, { status: 404 });
    if (!res.ok) throw new Error(String(res.status));
    const program = (await res.json()) as Record<string, unknown>;
    for (const k of HEAVY) delete program[k];
    const sec = program.securityTxt as { source_code?: string } | null;
    program.sourcePublic = await publicOnGitHub(sec?.source_code || program.repoUrlDeclared || program.repoUrl);
    let verification: unknown = null;
    let pending = false;
    if (program.network === "mainnet" && !program.closed) {
      if (v.ok) verification = await v.json();
      else pending = v.status === 503 && (await v.json().catch(() => ({}))).error === "still checking";
    }
    return NextResponse.json({ program, verification, pending });
  } catch {
    return NextResponse.json({ error: "couldn't check this one, try again shortly" }, { status: 502 });
  }
}

/** The doctor's verdict alone, for the guide to ask again while it's cold. */
async function verdict(id: string) {
  try {
    const v = await fetch(`${API_BASE}/api/programs/${id}/verification`, { cache: "no-store" });
    if (v.ok) return NextResponse.json({ verification: await v.json(), pending: false });
    const still = v.status === 503 && (await v.json().catch(() => ({}))).error === "still checking";
    return NextResponse.json({ verification: null, pending: still });
  } catch {
    return NextResponse.json({ error: "couldn't check this one, try again shortly" }, { status: 502 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action === "check") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!ADDRESS_RE.test(id)) return NextResponse.json({ error: "not a Solana address" }, { status: 400 });
    return new URL(req.url).searchParams.has("verdict") ? verdict(id) : check(id);
  }
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
