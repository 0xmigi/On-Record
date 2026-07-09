"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

/**
 * A monospace address — the on-chain-first primitive every surface leads with.
 * The text is either plain or a link to the dossier; the trailing icon copies
 * the full value to the clipboard.
 */
export function CopyAddress({
  value,
  display,
  href,
  className = "",
}: {
  value: string;
  display: string;
  href?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable — nothing to do
    }
  }, [value]);

  return (
    <span className={`copy-addr ${className}`.trim()}>
      {href ? (
        <Link className="copy-addr-text" href={href} title={value}>
          {display}
        </Link>
      ) : (
        <span className="copy-addr-text" title={value}>
          {display}
        </span>
      )}
      <button
        type="button"
        className="copy-addr-btn"
        onClick={copy}
        title={`Copy ${value}`}
        aria-label={`Copy address ${value}`}
      >
        <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
      </button>
    </span>
  );
}
