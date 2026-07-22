import type { Metadata } from "next";
import Link from "next/link";
import { ProgramRow } from "@/components/ProgramRow";
import { fetchSearch, looksLikeProgramId, type SearchSort } from "@/lib/api";

export const metadata: Metadata = {
  title: "Search",
  description: "Find a Solana program by name, crate, repo, or what it calls.",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; network?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const sort: SearchSort = params.sort === "recent" ? "recent" : "relevance";
  // deliberately unscoped: search spans both clusters whatever mode you came
  // from, with devnet rows badged and ranked below their mainnet equivalents
  const { items, truncated } = await fetchSearch(q, { limit: 50, sort });
  const devnetCount = items.filter((p) => p.network === "devnet").length;

  return (
    <>
      <h1 className="funnel-title">Search</h1>

      {q.length < 2 ? (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <p className="empty-title">Type at least two characters</p>
          <p className="saved-hint">
            Search matches a program&apos;s name, its Rust crate, its repo, and the
            protocols it calls — plus the strings recovered from its binary, which is
            how programs that published nothing at all still turn up.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <p className="empty-title">
            No match for <strong>{q}</strong>
          </p>
          <p className="saved-hint">
            {looksLikeProgramId(q) ? (
              <>
                That looks like a program address, but it isn&apos;t in the index — On
                Record only holds programs deployed or upgraded since it started
                watching. <Link href="/">Back to the radar</Link>.
              </>
            ) : (
              <>
                Nothing on mainnet or devnet matches. The index covers programs seen
                deploying or upgrading, not every program on chain — try the address
                directly, or <Link href="/">browse the radar</Link>.
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="search-summary">
            <p className="saved-hint">
              {truncated ? "50+" : items.length} match{items.length === 1 && !truncated ? "" : "es"}{" "}
              for <strong>{q}</strong>
              {devnetCount ? ` · ${devnetCount} on devnet` : ""}
            </p>
            <nav className="search-sort" aria-label="Sort results">
              <Link
                href={`/search?q=${encodeURIComponent(q)}`}
                className={sort === "relevance" ? "is-active" : ""}
                aria-current={sort === "relevance" ? "true" : undefined}
              >
                best match
              </Link>
              <Link
                href={`/search?q=${encodeURIComponent(q)}&sort=recent`}
                className={sort === "recent" ? "is-active" : ""}
                aria-current={sort === "recent" ? "true" : undefined}
              >
                newest
              </Link>
            </nav>
          </div>
          <ol className="radar-list">
            {items.map((p) => (
              <li key={p.id}>
                <ProgramRow program={p} showNetwork />
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
