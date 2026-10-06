"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { relativeTime } from "@/lib/format";

/**
 * Verification alert sign-up: paste an address, see what it controls, connect
 * Telegram (or a webhook), done — without leaving the page.
 *
 * Telegram won't let a bot message anyone who hasn't allowed it, so "Connect
 * Telegram" opens Telegram's own login popup asking that permission. The signed
 * login goes to the API, which checks it against the bot token and sends the
 * first message. Backend: apps/ingest/src/routes/alerts.ts.
 */

const BOT_ID = 8945444491; // @onrecord_verify_bot — public, the first half of its token
/** the one domain registered with BotFather; Telegram refuses the popup anywhere else */
const BOT_DOMAIN = "on-record.azuolas.xyz";
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Program {
  id: string;
  name: string | null;
  verified: boolean;
  lastEventAt: string | null;
  website: string | null;
  social: string | null;
  repoUrl: string | null;
  squads: { threshold: number; members: number } | null;
}

const SHOWN = 6;

/** What the address controls: one row per program, with whether its current
 *  build is verified — the thing the alerts are about. */
function WatchList({ programs }: { programs: Program[] }) {
  const [all, setAll] = useState(false);
  if (!programs.length) {
    return <p className="alert-signup-programs">No programs on record for this address yet. New deploys will be watched.</p>;
  }
  const squads = programs.find((p) => p.squads)?.squads;
  const rows = all ? programs : programs.slice(0, SHOWN);
  return (
    <div className="watch-list">
      <p className="watch-list-head">
        {programs.length} program{programs.length === 1 ? "" : "s"} to watch
        {squads ? ` · Squads multisig, ${squads.threshold} of ${squads.members}` : ""}
      </p>
      <ul>
        {rows.map((p) => (
          <li key={p.id}>
            <ProgramAvatar program={{ ...p, network: "mainnet" }} size={18} />
            <Link href={`/p/${p.id}`} className="watch-list-name" target="_blank">
              {p.name ?? short(p.id)}
            </Link>
            <span className={`vfy ${p.verified ? "vfy-yes" : "vfy-no"}`}>{p.verified ? "✓ verified" : "✗ not verified"}</span>
            <span className="watch-list-when">{p.lastEventAt ? `upgraded ${relativeTime(p.lastEventAt)}` : ""}</span>
          </li>
        ))}
      </ul>
      {programs.length > SHOWN && !all ? (
        <button type="button" className="alert-signup-alt" onClick={() => setAll(true)}>
          show all {programs.length}
        </button>
      ) : null}
    </div>
  );
}
type TelegramUser = Record<string, string | number>;
declare global {
  interface Window {
    Telegram?: {
      Login: {
        auth: (opts: { bot_id: number; request_access?: "write" }, cb: (user: TelegramUser | false) => void) => void;
      };
    };
  }
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

function loadTelegram(): Promise<void> {
  if (window.Telegram?.Login) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("couldn't load Telegram"));
    document.head.appendChild(s);
  });
}

export function AlertSignup() {
  const [address, setAddress] = useState("");
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [mode, setMode] = useState<"telegram" | "webhook">("telegram");
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const lookedUp = useRef("");

  const valid = ADDRESS_RE.test(address.trim());

  // look the address up as soon as it's a whole address — pasting is the usual way in
  useEffect(() => {
    const a = address.trim();
    if (!ADDRESS_RE.test(a) || lookedUp.current === a) return;
    lookedUp.current = a;
    setPrograms(null);
    setError(null);
    fetch(`/api/alerts/programs?address=${encodeURIComponent(a)}`)
      .then((r) => r.json())
      .then((d: { programs?: Program[]; error?: string }) => {
        if (lookedUp.current !== a) return;
        if (d.error) setError(d.error);
        else setPrograms(d.programs ?? []);
      })
      .catch(() => setError("couldn't look that address up, try again"));
    // preload the popup script so the click opens it immediately
    void loadTelegram().catch(() => {});
  }, [address]);

  const subscribe = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/alerts/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: address.trim(), ...body }),
      });
      const d = (await res.json()) as { error?: string; who?: string | null; already?: boolean };
      if (!res.ok || d.error) throw new Error(d.error ?? "sign-up failed");
      setDone(
        body.channel === "telegram"
          ? `${d.already ? "Already set" : "You're set"}${d.who ? `, ${d.who}` : ""}. Check Telegram for the first message.`
          : `${d.already ? "Already set" : "You're set"}. A test message just went to your webhook.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connectTelegram = async () => {
    setError(null);
    if (window.location.hostname !== BOT_DOMAIN) {
      setError(`Telegram sign-up only works on ${BOT_DOMAIN}. Use a webhook here.`);
      return;
    }
    try {
      await loadTelegram();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    window.Telegram!.Login.auth({ bot_id: BOT_ID, request_access: "write" }, (user) => {
      if (!user) setError("Telegram didn't connect. Tap Allow in the Telegram window to let the bot message you.");
      else void subscribe({ channel: "telegram", telegram: user });
    });
  };

  if (done) {
    return (
      <section className="alert-signup" aria-live="polite">
        <p className="alert-signup-done">✓ {done}</p>
      </section>
    );
  }

  return (
    <section className="alert-signup">
      <input
        className="alert-signup-input"
        placeholder="Upgrade authority or Squads multisig address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-label="Upgrade authority or Squads multisig address"
      />

      {valid && programs ? (
        <>
          <WatchList programs={programs} />

          {mode === "telegram" ? (
            <div className="alert-signup-row">
              <button type="button" className="alert-signup-btn" onClick={connectTelegram} disabled={busy}>
                {busy ? "Connecting…" : "Connect Telegram"}
              </button>
              <button type="button" className="alert-signup-alt" onClick={() => setMode("webhook")}>
                or a Discord/Slack webhook
              </button>
            </div>
          ) : (
            <div className="alert-signup-row">
              <input
                className="alert-signup-input"
                placeholder="https://discord.com/api/webhooks/…"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                spellCheck={false}
                aria-label="Webhook URL"
              />
              <button
                type="button"
                className="alert-signup-btn"
                disabled={busy || !webhook.trim()}
                onClick={() => void subscribe({ channel: "webhook", target: webhook.trim() })}
              >
                {busy ? "Sending test…" : "Subscribe"}
              </button>
              <button type="button" className="alert-signup-alt" onClick={() => setMode("telegram")}>
                use Telegram
              </button>
            </div>
          )}
        </>
      ) : null}

      {valid && !programs && !error ? <p className="alert-signup-programs">Looking up…</p> : null}
      {error ? <p className="alert-signup-error">{error}</p> : null}
    </section>
  );
}
