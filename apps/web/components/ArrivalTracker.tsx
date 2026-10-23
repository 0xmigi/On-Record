"use client";

import { useEffect } from "react";
import { track } from "@vercel/analytics";

/**
 * Records an "arrival" when someone lands from a tagged link, e.g. a DM that
 * links /p/<id>?ref=dm-w1. Vercel only shows referrer hosts, and DMs send none,
 * so the tag is the only way to tell which outreach got clicked.
 */
export function ArrivalTracker() {
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) track("arrival", { ref: ref.slice(0, 64), path: window.location.pathname });
  }, []);
  return null;
}
