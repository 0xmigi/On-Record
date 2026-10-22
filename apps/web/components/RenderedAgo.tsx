"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "@/lib/format";

/**
 * " · as of 7h ago" after a clock-relative number on a cached page. The server
 * can't know how old its own cached render will be when it's read, so this
 * renders nothing there and fills in on the client, and only once the render
 * is over an hour old.
 */
export function RenderedAgo({ at }: { at: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (Date.now() - Date.parse(at) > 3_600_000) setLabel(relativeTime(at));
  }, [at]);
  return label ? <span className="cell-dim"> · as of {label}</span> : null;
}
