"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Paste a program address, land on its dossier. No search index needed. */
export function SearchBox() {
  const router = useRouter();
  const [value, setValue] = useState("");

  return (
    <form
      className="search-form"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const id = value.trim();
        if (id) router.push(`/p/${encodeURIComponent(id)}`);
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
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste a program address…"
        aria-label="Look up a program address"
      />
    </form>
  );
}
