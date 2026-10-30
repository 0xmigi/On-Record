"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { track } from "@vercel/analytics";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { VerifyGuide, type GuideData } from "@/components/VerifyGuide";
import { relativeTime } from "@/lib/format";

/**
 * Verification check, then alerts. Paste a program (or the address that
 * upgrades it) and press Check: a program gets its guide to a verified build
 * (VerifyGuide), an authority gets the list of programs it controls, each of
 * which opens to its guide. Alerts sit under it, separately: they go to the
 * upgrade authority, so they cover every program it controls.
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

type Lookup =
  | { mode: "authority"; address: string; programs: Program[] }
  | {
      mode: "program";
      data: GuideData;
      /** the program's upgrade authority, when an alert could be about it */
      watch: string | null;
      /** what that authority controls, which its alerts cover */
      programs: Program[];
    }
  | { mode: "none" };

const SHOWN = 6;

/** the open mainnet programs an address controls, as the alerts would watch */
async function programsOf(address: string): Promise<Program[]> {
  const d = (await (await fetch(`/api/alerts/programs?address=${encodeURIComponent(address)}`)).json()) as {
    programs?: Program[];
    error?: string;
  };
  if (d.error) throw new Error(d.error);
  return d.programs ?? [];
}
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

/** An authority's programs, each opening to its checklist. */
function ProgramList({ programs }: { programs: Program[] }) {
  const squads = programs.find((p) => p.squads)?.squads ?? null;
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set(programs.length === 1 ? [programs[0]!.id] : []));
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const rows = all ? programs : programs.slice(0, SHOWN);
  return (
    <div className="watch-list">
      <ul>
        {rows.map((p) => (
          <li key={p.id}>
            <ProgramAvatar program={{ ...p, network: "mainnet" }} size={18} />
            <Link href={`/p/${p.id}`} prefetch={false} className="watch-list-name" target="_blank">
              {p.name ?? short(p.id)}
            </Link>
            <button
              type="button"
              className={`watch-list-toggle vfy ${p.verified ? "vfy-yes" : "vfy-no"}`}
              aria-expanded={open.has(p.id)}
              onClick={() => toggle(p.id)}
            >
              {p.verified ? "✓ verified" : "✗ not verified"}
              <span className="watch-list-caret">{open.has(p.id) ? "▾" : "▸"}</span>
            </button>
            <span className="watch-list-when">{p.lastEventAt ? `upgraded ${relativeTime(p.lastEventAt)}` : ""}</span>
            {open.has(p.id) ? (
              <div className="watch-list-detail">
                <VerifyGuide id={p.id} card={false} siblingSquads={squads} />
              </div>
            ) : null}
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

/** Alerts for an upgrade authority: Telegram or a webhook. */
function Alerts({ watch, count, squads }: { watch: string; count: number; squads: Program["squads"] }) {
  const [mode, setMode] = useState<"telegram" | "webhook">("telegram");
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // preload the popup script so the click opens it immediately
  useEffect(() => {
    void loadTelegram().catch(() => {});
  }, []);

  const subscribe = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/alerts/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: watch, ...body }),
      });
      const d = (await res.json()) as { error?: string; who?: string | null; already?: boolean };
      if (!res.ok || d.error) throw new Error(d.error ?? "sign-up failed");
      track("alert_signup", { channel: String(body.channel ?? "webhook"), repeat: !!d.already });
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

  return (
    <section className="alerts-block" aria-live="polite">
      <h2 className="related-title">
        Alerts
        <span
          className="info-dot"
          data-tip="A message when an upgrade leaves a program unverified, with the reason and the fix, and another when it's verified again."
          tabIndex={0}
          role="note"
        >
          i
        </span>
      </h2>
      <p className="watch-list-head">
        {count} program{count === 1 ? "" : "s"} · authority <span title={watch}>{short(watch)}</span>
        {squads ? ` · multisig ${squads.threshold} of ${squads.members}` : ""}
      </p>
      {done ? (
        <p className="alert-signup-done">✓ {done}</p>
      ) : mode === "telegram" ? (
        <div className="alert-signup-row">
          <button type="button" className="alert-signup-btn alert-signup-btn-quiet" onClick={connectTelegram} disabled={busy}>
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
            className="alert-signup-btn alert-signup-btn-quiet"
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
      {error ? <p className="alert-signup-error">{error}</p> : null}
    </section>
  );
}

export function AlertSignup() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = address.trim();
    if (!ADDRESS_RE.test(a)) return setError("not a Solana address");
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const controlled = await programsOf(a);
      if (controlled.length) return setResult({ mode: "authority", address: a, programs: controlled });
      // not an authority: a program id?
      const res = await fetch(`/api/alerts/check?id=${encodeURIComponent(a)}`);
      const d = (await res.json()) as GuideData & { error?: string };
      if (res.status === 404) return setResult({ mode: "none" });
      if (!res.ok) throw new Error(d.error);
      const p = d.program;
      const watch = p.network === "mainnet" && !p.closed && p.authorityClass !== "none" ? p.authority : null;
      setResult({ mode: "program", data: d, watch, programs: watch ? await programsOf(watch) : [] });
    } catch (err) {
      setError((err as Error).message || "couldn't look that address up, try again");
    } finally {
      setBusy(false);
    }
  };

  const watch = result?.mode === "authority" ? result.address : result?.mode === "program" ? result.watch : null;
  const controlled = result && result.mode !== "none" ? result.programs : [];
  const squads = controlled.find((p) => p.squads)?.squads ?? null;

  return (
    <section className="alert-signup">
      <form className="alert-signup-row alert-signup-form" onSubmit={check}>
        <input
          className="alert-signup-input"
          placeholder="Program id or upgrade authority"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="Program id or upgrade authority"
        />
        <button type="submit" className="alert-signup-btn" disabled={busy || !address.trim()}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>

      {error ? <p className="alert-signup-error">{error}</p> : null}

      {result?.mode === "none" ? <p className="alert-signup-programs">Not on record</p> : null}
      {result?.mode === "program" ? (
        <VerifyGuide id={result.data.program.id} initial={result.data} siblingSquads={squads} />
      ) : null}
      {result?.mode === "authority" ? <ProgramList programs={result.programs} /> : null}

      {watch && controlled.length ? <Alerts watch={watch} count={controlled.length} squads={squads} /> : null}
    </section>
  );
}
