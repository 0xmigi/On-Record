"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import {
  looksLikeProgramId,
  type ApiProgram,
  type ApiSearchResult,
} from "@/lib/api";

/** Paste a program address to land on its dossier, or type a name, crate,
 *  repo or protocol to search the index. Address input keeps the original
 *  zero-latency path: it never hits the search endpoint. */
export function SearchBox() {
  const router = useRouter();
  const listId = useId();

  const [value, setValue] = useState("");
  const [results, setResults] = useState<ApiProgram[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  const query = value.trim();
  const isAddress = looksLikeProgramId(query);

  // debounced lookup; an in-flight request is abandoned when the query moves on
  useEffect(() => {
    if (query.length < 2 || isAddress) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      // unscoped by design — devnet hits show up in mainnet mode, badged
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<ApiSearchResult>) : null))
        .then((data) => {
          if (controller.signal.aborted) return;
          setResults(data?.items ?? []);
          setActive(-1);
          setLoading(false);
        })
        .catch(() => {
          // AbortError is the normal path when typing continues
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isAddress]);

  // a closed dropdown keeps no highlight — otherwise reopening it restores a
  // stale selection and the next Enter goes somewhere the user didn't choose
  useEffect(() => {
    if (!open) setActive(-1);
  }, [open]);

  // click-away closes the dropdown
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const go = (id: string): void => {
    setOpen(false);
    setValue("");
    router.push(`/p/${encodeURIComponent(id)}`);
  };

  const submit = (): void => {
    if (!query) return;
    // an address is unambiguous — go straight there, no round trip
    if (isAddress) return go(query);
    if (active >= 0 && results[active]) return go(results[active].id);
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") return setOpen(false);
    // handled here rather than left to the form's implicit submission: with the
    // dropdown open, Enter must take the highlighted row, not the raw text
    if (e.key === "Enter") {
      e.preventDefault();
      return submit();
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    }
  };

  const showList = open && !isAddress && query.length >= 2;

  return (
    <div className="search-wrap" ref={boxRef}>
      <form
        className="search-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="search-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          className="search-input"
          type="search"
          name="q"
          value={value}
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search a name, or paste an address…"
          aria-label="Search programs by name or address"
        />
        {loading && !isAddress ? (
          <span className="search-spinner" aria-hidden="true" />
        ) : null}
      </form>

      {showList ? (
        <ul className="search-results" id={listId} role="listbox">
          {results.length === 0 && !loading ? (
            <li className="search-empty">
              No program matches <strong>{query}</strong> in the index.
            </li>
          ) : null}
          {results.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`search-result${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r.id)}
              >
                <span className="search-result-name">
                  {r.name ?? <span className="search-result-anon">unnamed</span>}
                </span>
                <span className="search-result-meta">
                  <span className="search-result-id">{r.id.slice(0, 6)}…</span>
                  {r.network === "devnet" ? (
                    <span className="search-result-tag is-devnet">devnet</span>
                  ) : null}
                  {r.category !== "unknown" ? (
                    <span className="search-result-tag">{r.category}</span>
                  ) : null}
                  {r.framework && r.framework !== "unknown" ? (
                    <span className="search-result-tag">{r.framework}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
          {results.length ? (
            <li>
              <button
                type="button"
                className="search-result search-all"
                onClick={() => {
                  setOpen(false);
                  router.push(`/search?q=${encodeURIComponent(query)}`);
                }}
              >
                See all matches for “{query}”
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
