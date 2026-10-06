"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/** The manage link every alert carries: what it watches, and a way to stop. */

interface Sub {
  address: string;
  channel: string;
  target: string;
  active: boolean;
  programs: { id: string; name: string | null }[];
}

export function AlertManage() {
  const token = useSearchParams().get("manage") ?? "";
  const [sub, setSub] = useState<Sub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("This link is missing its key.");
      return;
    }
    fetch(`/api/alerts/subscription?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d: Sub & { error?: string }) => (d.error ? setError(d.error) : setSub(d)))
      .catch(() => setError("Couldn't load this sign-up, try again."));
  }, [token]);

  const stop = async () => {
    setBusy(true);
    const res = await fetch("/api/alerts/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok && sub) setSub({ ...sub, active: false });
    else setError("Couldn't turn alerts off, try again.");
  };

  if (error) return <p className="alert-signup-error">{error}</p>;
  if (!sub) return <p className="essay-meta">Loading…</p>;
  return (
    <section className="alert-signup">
      <p className="alert-signup-programs">
        <code>{sub.address}</code> → {sub.target}
        <br />
        {sub.programs.length} program{sub.programs.length === 1 ? "" : "s"} watched
      </p>
      {sub.active ? (
        <button type="button" className="alert-signup-btn" onClick={stop} disabled={busy}>
          {busy ? "Turning off…" : "Turn off alerts"}
        </button>
      ) : (
        <p className="alert-signup-done">Alerts are off.</p>
      )}
    </section>
  );
}
