"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { track } from "@vercel/analytics";
import { ProgramAvatar } from "@/components/ProgramAvatar";
import { VerifyGuide, type GuideData } from "@/components/VerifyGuide";
import { isOnCurve } from "@/lib/curve";
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
  /** how the address relates: it is the upgrade authority, or the multisig behind it */
  via: "authority" | "multisig";
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
  | { mode: "none"; address: string };

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

/** What the pasted address is, in a word. Wallet or not is the curve test:
 *  only an address on the curve has a private key; one off it is signed for
 *  by a program (a multisig vault, a program's own PDA). */
function kindOf(r: Lookup): string {
  if (r.mode === "program") return "program";
  if (r.mode === "none") return "not on record";
  if (r.programs.some((p) => p.via === "multisig" || p.squads)) return "multisig";
  return isOnCurve(r.address) ? "wallet" : "PDA";
}

/** An authority's programs. Each opens as its own check; the steps belong to
 *  one program, so they never show in the list. */
function ProgramList({ programs, onOpen }: { programs: Program[]; onOpen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = all ? programs : programs.slice(0, SHOWN);
  return (
    <div className="watch-list lookup-card">
      <ul>
        {rows.map((p) => (
          <li key={p.id}>
            <ProgramAvatar program={{ ...p, network: "mainnet" }} size={18} />
            <button type="button" className="watch-list-name watch-list-open" onClick={() => onOpen(p.id)}>
              {p.name ?? short(p.id)}
            </button>
            <button
              type="button"
              className={`watch-list-toggle vfy ${p.verified ? "vfy-yes" : "vfy-no"}`}
              onClick={() => onOpen(p.id)}
            >
              {p.verified ? "✓ verified" : "✗ not verified"}
              <span className="watch-list-caret">›</span>
            </button>
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

/** Telegram's mark, in its own blue */
function TelegramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#26A5E4"
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
      />
    </svg>
  );
}

/** Discord's mark, in its own blurple */
function DiscordIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#5865F2"
        d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
      />
    </svg>
  );
}

/** a webhook: any URL that takes a POST (Slack, a server of their own) */
function WebhookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </svg>
  );
}

/** Alerts for an upgrade authority: Telegram or a webhook. */
function Alerts({
  watch,
  single,
  scope,
}: {
  watch: string;
  /** one program was checked, or the list holds one */
  single: boolean;
  /** what the alerts cover, when the page above doesn't already show it */
  scope: string | null;
}) {
  /** which webhook form is open, if any; Telegram needs no form */
  const [hook, setHook] = useState<"discord" | "webhook" | null>(null);
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
      {/* the question on the left, picking up from the steps above; the ways to
          get the alert on the right */}
      <div className="alerts-ask">
        <p className="alerts-q">
          Get alerts if {single ? "this fails" : "any fail"}{" "}
          {/* the dot stays with the last word when the question wraps */}
          <span className="alerts-q-end">
            verification
            <span
              className="info-dot"
              data-tip="A message when an upgrade leaves a program unverified, with the reason and the fix, and another when it's verified again."
              tabIndex={0}
              role="note"
            >
              i
            </span>
          </span>
        </p>
        {/* a program's alerts follow its authority: say so when that covers more than it */}
        {scope ? <p className="watch-list-head">{scope}</p> : null}
      </div>
      {done ? (
        <p className="alert-signup-done">✓ {done}</p>
      ) : (
        <div className="alerts-connect">
          <button
            type="button"
            className="alert-signup-btn alert-signup-btn-quiet alerts-icon-btn"
            onClick={connectTelegram}
            disabled={busy}
            title="Telegram"
            aria-label="Alerts on Telegram"
          >
            <TelegramIcon />
          </button>
          {(["discord", "webhook"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="alert-signup-btn alert-signup-btn-quiet alerts-icon-btn"
              aria-pressed={hook === k}
              onClick={() => setHook(hook === k ? null : k)}
              title={k === "discord" ? "Discord webhook" : "Webhook (Slack or any URL)"}
              aria-label={k === "discord" ? "Alerts to a Discord webhook" : "Alerts to a webhook"}
            >
              {k === "discord" ? <DiscordIcon /> : <WebhookIcon />}
            </button>
          ))}
        </div>
      )}
      {!done && hook ? (
        <div className="alert-signup-row alerts-webhook">
          <input
            className="alert-signup-input"
            placeholder={hook === "discord" ? "https://discord.com/api/webhooks/…" : "https://hooks.slack.com/… or any URL"}
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
        </div>
      ) : null}
      {error ? <p className="alert-signup-error">{error}</p> : null}
    </section>
  );
}

export function AlertSignup() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async (a: string) => {
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
      if (res.status === 404) return setResult({ mode: "none", address: a });
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
  const check = (e: React.FormEvent) => {
    e.preventDefault();
    void lookup(address.trim());
  };
  /** a program picked from an authority's list: check it on its own */
  const open = (id: string) => {
    setAddress(id);
    void lookup(id);
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

      {/* a line down from the input, saying what the address is */}
      {result ? <p className="lookup-link">{kindOf(result)}</p> : null}
      {result?.mode === "program" ? (
        <VerifyGuide id={result.data.program.id} initial={result.data} siblingSquads={squads} />
      ) : null}
      {result?.mode === "authority" ? <ProgramList programs={result.programs} onOpen={open} /> : null}

      {watch && controlled.length ? (
        <Alerts
          watch={watch}
          single={result?.mode === "program" || controlled.length === 1}
          scope={result?.mode === "program" && controlled.length > 1 ? `covers all ${controlled.length} programs under ${short(watch)}` : null}
        />
      ) : null}
    </section>
  );
}
