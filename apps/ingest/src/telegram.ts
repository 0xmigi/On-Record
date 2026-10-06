import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema, logger } from "@onrecord/core";

// ---------------------------------------------------------------------------
// The Telegram channel for verification alerts: @onrecord_verify_bot.
//
// Telegram won't let a bot message anyone who hasn't allowed it, so sign-up
// goes through Telegram's own login popup with write access requested. The
// popup hands the page a signed user record; verifyTelegramLogin checks the
// signature against the bot token, and the user's id is the chat to message.
//
// The bot also answers /status (what this chat watches) and /stop (turn every
// alert for this chat off), read by long-polling getUpdates from the single
// live process.
// ---------------------------------------------------------------------------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const SITE = "https://on-record.azuolas.xyz";
/** a login older than this is a replay, not a sign-up */
const LOGIN_MAX_AGE_S = 15 * 60;

export const telegramEnabled = () => TOKEN.length > 0;

export interface TelegramLogin {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/** https://core.telegram.org/widgets/login#checking-authorization */
export function verifyTelegramLogin(raw: unknown): TelegramLogin {
  if (!TOKEN) throw new Error("Telegram alerts aren't set up");
  const u = raw as Record<string, unknown> | null;
  if (!u || typeof u.hash !== "string" || typeof u.id !== "number" || typeof u.auth_date !== "number") {
    throw new Error("not a Telegram login");
  }
  const check = Object.keys(u)
    .filter((k) => k !== "hash" && u[k] != null)
    .sort()
    .map((k) => `${k}=${u[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(TOKEN).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  const given = Buffer.from(u.hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error("Telegram login didn't verify");
  }
  if (Date.now() / 1000 - u.auth_date > LOGIN_MAX_AGE_S) throw new Error("Telegram login expired, try again");
  return u as unknown as TelegramLogin;
}

export async function sendTelegram(chatId: string, text: string): Promise<void> {
  if (!TOKEN) throw new Error("Telegram alerts aren't set up");
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { description?: string } | null;
    throw new Error(`Telegram: ${body?.description ?? `HTTP ${res.status}`}`);
  }
}

// --- bot commands -------------------------------------------------------------

async function reply(chatId: number, text: string): Promise<void> {
  await sendTelegram(String(chatId), text).catch((err: unknown) =>
    logger.warn({ chatId, err: String(err) }, "telegram: reply failed"),
  );
}

async function handle(chatId: number, text: string): Promise<void> {
  const cmd = text.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  const subs = await db
    .select({ id: schema.alertSubscriptions.id, address: schema.alertSubscriptions.address })
    .from(schema.alertSubscriptions)
    .where(
      and(
        eq(schema.alertSubscriptions.channel, "telegram"),
        eq(schema.alertSubscriptions.target, String(chatId)),
        isNull(schema.alertSubscriptions.revokedAt),
      ),
    );

  if (cmd === "/stop") {
    if (!subs.length) return reply(chatId, "No alerts are on for this chat.");
    await db
      .update(schema.alertSubscriptions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.alertSubscriptions.channel, "telegram"),
          eq(schema.alertSubscriptions.target, String(chatId)),
          isNull(schema.alertSubscriptions.revokedAt),
        ),
      );
    return reply(chatId, `Alerts off for ${subs.length} address${subs.length === 1 ? "" : "es"}. Sign up again any time at ${SITE}/verification`);
  }
  if (cmd === "/status") {
    if (!subs.length) return reply(chatId, `No alerts are on for this chat. Sign up at ${SITE}/verification`);
    const lines = subs.map((s) => `- ${s.address}`);
    return reply(chatId, ["Watching every mainnet program controlled by:", ...lines, "", "/stop turns them all off."].join("\n"));
  }
  return reply(
    chatId,
    `This bot pings you when a Solana mainnet upgrade leaves your program unverified. Sign up with your deploy address at ${SITE}/verification\n\n/status shows what this chat watches. /stop turns alerts off.`,
  );
}

/** Long-poll getUpdates for as long as the process lives. Offsets live in
 *  memory, so a restart may answer a recent command twice; every command here
 *  is safe to repeat. */
export function startTelegramBot(): void {
  if (!TOKEN) {
    logger.info("telegram: no bot token, commands off");
    return;
  }
  let offset = 0;
  const loop = async (): Promise<void> => {
    for (;;) {
      try {
        const res = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message"]`, {
          signal: AbortSignal.timeout(35_000),
        });
        const body = (await res.json()) as {
          ok: boolean;
          result?: { update_id: number; message?: { chat: { id: number; type: string }; text?: string } }[];
        };
        for (const u of body.result ?? []) {
          offset = u.update_id + 1;
          const m = u.message;
          if (m?.text && m.chat.type === "private") await handle(m.chat.id, m.text);
        }
        if (!body.ok) await new Promise((r) => setTimeout(r, 10_000));
      } catch (err) {
        logger.warn({ err: String(err) }, "telegram: getUpdates failed");
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
  logger.info("telegram: bot listening");
}
