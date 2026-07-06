import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import {
  db,
  schema,
  env,
  getConfig,
  logger,
  LIMITS,
  type StoryDraft,
  type StoryFact,
  type StoryType,
} from "@onrecord/core";
import { writerSystemPrompt, writerUserPrompt, type FactPack } from "./prompts.js";

// ---------------------------------------------------------------------------
// Write stage (spec §4.5): one LLM call per story, structured JSON out via a
// forced tool call. Output is validated structurally here and factually in
// verify.ts.
// ---------------------------------------------------------------------------

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || undefined });

const STORY_TYPES: StoryType[] = [
  "update",
  "launch",
  "radar",
  "became_real",
  "corroboration",
  "control_change",
  "copy_wave",
];

const PUBLISH_TOOL: Anthropic.Tool = {
  name: "publish_story",
  description: "Publish the finished story. Call exactly once.",
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: STORY_TYPES },
      headline: { type: "string", description: `≤ ${LIMITS.headline} chars` },
      body: { type: "string", description: `≤ 280 chars target, ${LIMITS.body} hard cap` },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            receipt: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["tx", "account", "repo"] },
                ref: { type: "string" },
              },
              required: ["kind", "ref"],
            },
          },
          required: ["text", "receipt"],
        },
      },
      inference: {
        type: ["object", "null"],
        properties: {
          text: { type: "string", description: `≤ ${LIMITS.inference} chars` },
          confidence: { type: "string", enum: ["low", "med", "high"] },
        },
        required: ["text", "confidence"],
      },
      subjects: { type: "array", items: { type: "string" } },
    },
    required: ["type", "headline", "body", "facts", "inference", "subjects"],
  },
};

export async function writeStory(
  pack: FactPack,
  rewriteErrors?: string[],
): Promise<StoryDraft> {
  const cfg = await getConfig();
  await assertTokenBudget(cfg.MONTHLY_TOKEN_CAP);

  const response = await client.messages.create({
    model: env.WRITER_MODEL,
    max_tokens: 2048,
    system: writerSystemPrompt(cfg.toneNotes),
    tools: [PUBLISH_TOOL],
    tool_choice: { type: "tool", name: "publish_story" },
    messages: [{ role: "user", content: writerUserPrompt(pack, rewriteErrors) }],
  });

  await recordTokenUsage(response.usage.input_tokens + response.usage.output_tokens);

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "publish_story",
  );
  if (!toolUse) throw new Error("writer returned no publish_story call");
  return parseDraft(toolUse.input);
}

/** Structural validation of the tool output — the model is forced into the
 *  tool but we never trust the shape blindly. */
function parseDraft(input: unknown): StoryDraft {
  const o = input as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("draft is not an object");
  if (!STORY_TYPES.includes(o.type as StoryType)) throw new Error(`bad story type: ${String(o.type)}`);
  if (typeof o.headline !== "string" || !o.headline.trim()) throw new Error("missing headline");
  if (typeof o.body !== "string" || !o.body.trim()) throw new Error("missing body");
  if (!Array.isArray(o.facts) || o.facts.length === 0) throw new Error("facts must be non-empty");

  const facts: StoryFact[] = o.facts.map((f) => {
    const fact = f as { text?: unknown; receipt?: { kind?: unknown; ref?: unknown } };
    if (typeof fact.text !== "string" || !fact.text.trim()) throw new Error("fact missing text");
    const kind = fact.receipt?.kind;
    const ref = fact.receipt?.ref;
    if (kind !== "tx" && kind !== "account" && kind !== "repo") throw new Error("fact receipt kind invalid");
    if (typeof ref !== "string" || !ref.trim()) throw new Error("fact receipt ref invalid");
    return { text: fact.text, receipt: { kind, ref } };
  });

  let inference: StoryDraft["inference"] = null;
  if (o.inference != null) {
    const inf = o.inference as { text?: unknown; confidence?: unknown };
    if (typeof inf.text !== "string") throw new Error("inference missing text");
    if (inf.confidence !== "low" && inf.confidence !== "med" && inf.confidence !== "high") {
      throw new Error("inference confidence invalid");
    }
    inference = { text: inf.text, confidence: inf.confidence };
  }

  const subjects = Array.isArray(o.subjects) ? o.subjects.filter((s): s is string => typeof s === "string") : [];
  if (subjects.length === 0) throw new Error("subjects must be non-empty");

  return { type: o.type as StoryType, headline: o.headline.trim(), body: o.body.trim(), facts, inference, subjects };
}

// ---------------------------------------------------------------------------
// Backpressure on LLM spend (spec §8): hard monthly token cap tracked in the
// config table.
// ---------------------------------------------------------------------------

function monthKey(): string {
  return `tokenUsage:${new Date().toISOString().slice(0, 7)}`;
}

async function assertTokenBudget(cap: number): Promise<void> {
  const rows = await db.select().from(schema.config).where(eq(schema.config.key, monthKey()));
  const used = Number(rows[0]?.value ?? 0);
  if (used >= cap) throw new Error(`monthly token cap reached (${used}/${cap})`);
}

async function recordTokenUsage(tokens: number): Promise<void> {
  const key = monthKey();
  const rows = await db.select().from(schema.config).where(eq(schema.config.key, key));
  const used = Number(rows[0]?.value ?? 0) + tokens;
  await db
    .insert(schema.config)
    .values({ key, value: used, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.config.key, set: { value: used, updatedAt: new Date() } });
  logger.debug({ key, used }, "writer token usage");
}
