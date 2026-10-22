import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredSample, TrafficSample } from "@onrecord/core";
import { liveTrafficSampler } from "./traffic-live.js";

// What ?sample=live on the dossier can cost: nothing when the stored sample is
// recent, one measurement per program however many ask at once, and a fixed
// number an hour across every program.

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-23T12:00:00Z");
const MEASURED = { signaturesSeen: 1 } as TrafficSample;

function sampler(stored: Record<string, Date | null>, opts: { limit?: number } = {}) {
  let t = T0;
  const measured: string[] = [];
  const live = liveTrafficSampler({
    async read(id) {
      const at = stored[id] ?? null;
      return { value: at ? ({ signaturesSeen: 0 } as TrafficSample) : null, sampledAt: at };
    },
    async measure(_network, id): Promise<StoredSample<TrafficSample>> {
      measured.push(id);
      await new Promise((r) => setTimeout(r, 5));
      return { value: MEASURED, sampledAt: new Date(t) };
    },
    maxPerHour: opts.limit ?? 10,
    staleMs: HOUR,
    now: () => t,
  });
  return { live, measured, advance: (ms: number) => (t += ms) };
}

test("a sample under the stale age is served, not re-measured", async () => {
  const { live, measured } = sampler({ A: new Date(T0 - 10 * 60_000) });
  const r = await live("mainnet", "A");
  assert.equal(r.declined, "fresh");
  assert.equal(r.sample.value?.signaturesSeen, 0);
  assert.deepEqual(measured, []);
});

test("an old sample, or none at all, is measured now", async () => {
  const { live, measured } = sampler({ A: new Date(T0 - 2 * HOUR), B: null });
  assert.equal((await live("mainnet", "A")).declined, null);
  const b = await live("mainnet", "B");
  assert.equal(b.declined, null);
  assert.equal(b.sample.value, MEASURED);
  assert.deepEqual(measured, ["A", "B"]);
});

test("past the hourly ceiling the stored sample is served, and the next hour measures again", async () => {
  const { live, measured, advance } = sampler({ A: null, B: null, C: new Date(T0 - 3 * HOUR) }, { limit: 2 });
  assert.equal((await live("mainnet", "A")).declined, null);
  assert.equal((await live("mainnet", "B")).declined, null);
  const c = await live("mainnet", "C");
  assert.equal(c.declined, "budget");
  assert.equal(c.sample.value?.signaturesSeen, 0); // what was stored
  assert.deepEqual(measured, ["A", "B"]);

  advance(HOUR + 1);
  assert.equal((await live("mainnet", "C")).declined, null);
  assert.deepEqual(measured, ["A", "B", "C"]);
});

test("concurrent requests for one program share one measurement and one budget slot", async () => {
  const { live, measured } = sampler({ A: null, B: null }, { limit: 2 });
  const all = await Promise.all([live("mainnet", "A"), live("mainnet", "A"), live("mainnet", "A")]);
  assert.deepEqual(
    all.map((r) => r.declined),
    [null, null, null],
  );
  assert.deepEqual(measured, ["A"]);
  // the second slot is still there
  assert.equal((await live("mainnet", "B")).declined, null);
});
