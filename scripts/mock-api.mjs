// Zero-dependency mock of the On Record read API, for fast UI iteration
// without Postgres/Redis/Docker. Serves one seeded "demo day" covering every
// story type. Run: node scripts/mock-api.mjs  (listens on :3001)
//
// The web app (apps/web) reads from API_URL — point it here:
//   API_URL=http://localhost:3001 pnpm --filter @onrecord/web dev
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3001);
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

// --- subjects -------------------------------------------------------------
const SUBJECTS = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    kind: "program", name: "Jupiter", network: "mainnet", verified: true,
    repoUrl: "https://github.com/jup-ag/jupiter-core", authorityClass: "squads",
    tvl: 2_410_000_000, noveltyScore: 0, bucketId: null,
  },
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: {
    kind: "program", name: "Kamino", network: "mainnet", verified: true,
    repoUrl: "https://github.com/Kamino-Finance/klend", authorityClass: "squads",
    tvl: 1_870_000_000, noveltyScore: 0.1, bucketId: null,
  },
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: {
    kind: "program", name: "Drift", network: "mainnet", verified: true,
    repoUrl: "https://github.com/drift-labs/protocol-v2", authorityClass: "program",
    tvl: 950_000_000, noveltyScore: 0, bucketId: null,
  },
  "7vXqKvB2mYzXhBpTn4NxFhWcJqEeUkPnLxAvGrDhTk3q": {
    kind: "program", name: null, network: "mainnet", verified: false,
    repoUrl: null, authorityClass: "hot_wallet", tvl: 4_200_000, noveltyScore: 0.94, bucketId: null,
  },
  "9aRwFkq3sVtDmZePnB5cWuXhYgJqTdKvNbMxUwErA2Ls": {
    kind: "program", name: "MarginFi", network: "mainnet", verified: false,
    repoUrl: null, authorityClass: "none", tvl: 95_000_000, noveltyScore: 0.2, bucketId: null,
  },
  "4kTpNvWyBmZcQhXsAeR2dFuJgLbVwMrEnUqYxKa3Pz8t": {
    kind: "program", name: null, network: "mainnet", verified: false,
    repoUrl: null, authorityClass: "hot_wallet", tvl: 12_800_000, noveltyScore: 0.81, bucketId: null,
  },
};
const subjectRef = (id) => ({ id, name: SUBJECTS[id]?.name ?? null });

// --- underlying events (THE RECORD tables) --------------------------------
const EVENTS = {
  evt_demo06: { network: "mainnet", type: "upgrade", signature: "7EqtTzAcFqYgUlBwEiV6hJyNkPfZaQvIrYuCbOe7Td3x8pXtRzAcFqYgUlBwEiV6hJyNkPfZaQvIrYuCbOe7T", slot: 334494800, blockTime: iso(7), programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", authorityBefore: null, authorityAfter: "GovnrDemo", sha256After: "d7e8f9a0", enrichment: {} },
  evt_demo05: { network: "mainnet", type: "set_authority", signature: "6DpsSyZbEpXfTkAvDhU5gIxMjOeYzPuHqXtBaNd6Sc2w7oWsQyZbEpXfTkAvDhU5gIxMjOeYzPuHqXtBaNd6S", slot: 334515600, blockTime: iso(1.5), programId: "9aRwFkq3sVtDmZePnB5cWuXhYgJqTdKvNbMxUwErA2Ls", authorityBefore: "TeamKey", authorityAfter: null, sha256After: null, enrichment: {} },
  evt_demo01: { network: "mainnet", type: "upgrade", signature: "2ZkoWgqLtRfE8mYzXhBpTn4NxFhWcJqEeUkPnLxAvGrDhTk3qKvB2mYzXhBpTn4NxFhWcJqEeUkPnLxAvGrDh", slot: 334512890, blockTime: iso(3), programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", authorityBefore: "GZctH", authorityAfter: "GZctH", sha256After: "a1b2c3d4", enrichment: {} },
  evt_demo03: { network: "mainnet", type: "deploy", signature: "4BnqQwXzCnAdRiYtBfS3eGvKhMcWxNsFoVrZyLb4Qa9u5mUqOwXzCnAdRiYtBfS3eGvKhMcWxNsFoVrZyLb4Q", slot: 334509455, blockTime: iso(4), programId: "7vXqKvB2mYzXhBpTn4NxFhWcJqEeUkPnLxAvGrDhTk3q", authorityBefore: null, authorityAfter: "Fh8Vm", sha256After: "c9d0e1f2", enrichment: {} },
  evt_demo04: { network: "mainnet", type: "deploy", signature: "5CorRxYaDoWeSjZuCgT4fHwLiNdXyOtGpWsAzMc5Rb1v6nVrPxYaDoWeSjZuCgT4fHwLiNdXyOtGpWsAzMc5R", slot: 334501200, blockTime: iso(5), programId: "4kTpNvWyBmZcQhXsAeR2dFuJgLbVwMrEnUqYxKa3Pz8t", authorityBefore: null, authorityAfter: "AuthKeyDemo", sha256After: "b3c4d5e6", enrichment: {} },
  evt_demo02: { network: "mainnet", type: "deploy", signature: "3AmnPvWyBmZcQhXsAeR2dFuJgLbVwMrEnUqYxKa3Pz8t4kTpNvWyBmZcQhXsAeR2dFuJgLbVwMrEnUqYxKa3P", slot: 334498120, blockTime: iso(6), programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", authorityBefore: null, authorityAfter: "7hPqS", sha256After: "e5f6a7b8", enrichment: {} },
};
const withId = (id) => ({ id, ...EVENTS[id] });

// --- stories (newest first) ----------------------------------------------
const STORIES = [
  {
    id: "sty_d07", type: "corroboration", pinned: true, status: "pinned", publishedAt: iso(0.9),
    headline: "Drift said v3 is live — it is, and the code matches",
    body: "Drift announced v3 this morning. The record agrees: the update went live seven hours ago and the running code matches the public v3 release.",
    facts: [
      { text: "The update went live at 08:41 UTC.", receipt: { kind: "tx", ref: EVENTS.evt_demo06.signature } },
      { text: "The code is public and matches what is running.", receipt: { kind: "repo", ref: "https://github.com/drift-labs/protocol-v2/commit/9f31c2a" } },
      { text: "This is the announcement being checked.", receipt: { kind: "repo", ref: "https://x.com/DriftProtocol/status/example" } },
    ],
    inference: null,
    subjects: [subjectRef("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH")],
    eventIds: ["evt_demo06"],
  },
  {
    id: "sty_d06", type: "control_change", pinned: false, status: "published", publishedAt: iso(1.4),
    headline: "A $95M lending app just froze itself",
    body: "MarginFi gave up the ability to change its own code. With $95M held in it, whatever is running now is what runs forever.",
    facts: [
      { text: "Control was removed at 14:12 UTC — no one can change it now.", receipt: { kind: "tx", ref: EVENTS.evt_demo05.signature } },
      { text: "About $95M is held in it.", receipt: { kind: "account", ref: "9aRwFkq3sVtDmZePnB5cWuXhYgJqTdKvNbMxUwErA2Ls" } },
    ],
    inference: null,
    subjects: [subjectRef("9aRwFkq3sVtDmZePnB5cWuXhYgJqTdKvNbMxUwErA2Ls")],
    eventIds: ["evt_demo05"],
  },
  {
    id: "sty_d05", type: "update", pinned: false, status: "published", publishedAt: iso(3),
    headline: "Jupiter shipped an update to its main exchange",
    body: "Jupiter updated its core exchange today. The code is public and matches — the change reworks how orders are split across venues and trims two fee paths.",
    facts: [
      { text: "The update went live at 12:33 UTC.", receipt: { kind: "tx", ref: EVENTS.evt_demo01.signature } },
      { text: "The code is public and matches what is running.", receipt: { kind: "repo", ref: "https://github.com/jup-ag/jupiter-core/commit/4e8ba17" } },
    ],
    inference: null,
    subjects: [subjectRef("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")],
    eventIds: ["evt_demo01"],
  },
  {
    id: "sty_d04", type: "radar", pinned: false, status: "published", publishedAt: iso(4),
    headline: "Something new is live and already holding $4.2M",
    body: "A new app went live four hours ago that matches nothing we have seen before. It is controlled by a single key and already holds $4.2M.",
    facts: [
      { text: "It went live at 11:02 UTC.", receipt: { kind: "tx", ref: EVENTS.evt_demo03.signature } },
      { text: "About $4.2M is held in it.", receipt: { kind: "account", ref: "7vXqKvB2mYzXhBpTn4NxFhWcJqEeUkPnLxAvGrDhTk3q" } },
    ],
    inference: { text: "The naming inside the code points at a perpetuals exchange. We do not know who is behind it yet.", confidence: "low" },
    subjects: [subjectRef("7vXqKvB2mYzXhBpTn4NxFhWcJqEeUkPnLxAvGrDhTk3q")],
    eventIds: ["evt_demo03"],
  },
  {
    id: "sty_d03", type: "became_real", pinned: false, status: "published", publishedAt: iso(5),
    headline: "Tested in the lab for 3 weeks — now it is live",
    body: "An app we have watched on the test network for 3 weeks went live for real today, launched by the same key that ran the tests.",
    facts: [
      { text: "It went live at 10:14 UTC.", receipt: { kind: "tx", ref: EVENTS.evt_demo04.signature } },
      { text: "The same code was rehearsed on the test network 14 times.", receipt: { kind: "account", ref: "4kTpNvWyBmZcQhXsAeR2dFuJgLbVwMrEnUqYxKa3Pz8t" } },
    ],
    inference: { text: "Three weeks of steady rehearsal before launch usually means a funded team, not a hobbyist.", confidence: "med" },
    subjects: [subjectRef("4kTpNvWyBmZcQhXsAeR2dFuJgLbVwMrEnUqYxKa3Pz8t")],
    eventIds: ["evt_demo04"],
  },
  {
    id: "sty_d02", type: "launch", pinned: false, status: "published", publishedAt: iso(6),
    headline: "Kamino launched a new lending market",
    body: "Kamino put a new lending market live this morning. The code is public and matches, and it is controlled by a team key.",
    facts: [
      { text: "It went live at 09:20 UTC.", receipt: { kind: "tx", ref: EVENTS.evt_demo02.signature } },
      { text: "The code is public and matches what is running.", receipt: { kind: "repo", ref: "https://github.com/Kamino-Finance/klend/commit/b21f90c" } },
    ],
    inference: null,
    subjects: [subjectRef("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD")],
    eventIds: ["evt_demo02"],
  },
  {
    id: "sty_d01", type: "copy_wave", pinned: false, status: "published", publishedAt: iso(7),
    headline: "34 copies of the same token launcher in 6 hours",
    body: "34 copies of one token launcher went live in the last 6 hours — the same code stamped out again and again by different keys.",
    facts: [{ text: "34 copies appeared in the last 6 hours.", receipt: { kind: "account", ref: "Copy1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } }],
    inference: null,
    subjects: [{ id: "Copy1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", name: null }],
    eventIds: [],
  },
];

const LAB = [
  { id: "wl_d1", kind: "fingerprint", programId: "Lab1TestNetApp", authority: null, source: "devnet_novel", note: null, firstSeenAt: iso(19 * 24), lastSeenAt: iso(6), deployCount: 23, expiresAt: iso(-41 * 24), status: "active" },
  { id: "wl_d2", kind: "fingerprint", programId: "Lab2TestNetApp", authority: null, source: "devnet_novel", note: null, firstSeenAt: iso(11 * 24), lastSeenAt: iso(2 * 24), deployCount: 8, expiresAt: iso(-49 * 24), status: "active" },
  { id: "wl_d3", kind: "authority", programId: null, authority: "6pYzVrSaAzPcTeGgWlJuCbNfHi5YxZqRvDpOk7Ec9Fm3", source: "manual", note: "Team behind the March options launch — said v2 is coming.", firstSeenAt: iso(4 * 24), lastSeenAt: iso(4 * 24), deployCount: 1, expiresAt: iso(-56 * 24), status: "active" },
];

const STATS = { launchesToday: 1, updatesToday: 1, copyPercentToday: 92, radarThisWeek: 1 };
const publicStory = ({ eventIds, ...rest }) => rest;

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/health") return send(res, 200, { ok: true });
  if (p === "/api/stats") return send(res, 200, STATS);
  if (p === "/api/lab") return send(res, 200, LAB);

  if (p === "/api/stories") {
    const type = url.searchParams.get("type");
    const items = STORIES.filter((s) => !type || s.type === type).map(publicStory);
    return send(res, 200, { items, nextCursor: null });
  }

  const storyMatch = p.match(/^\/api\/stories\/(.+)$/);
  if (storyMatch) {
    const story = STORIES.find((s) => s.id === decodeURIComponent(storyMatch[1]));
    if (!story) return send(res, 404, { error: "story not found" });
    return send(res, 200, { ...publicStory(story), events: story.eventIds.map(withId) });
  }

  const subjMatch = p.match(/^\/api\/subjects\/(.+)$/);
  if (subjMatch) {
    const id = decodeURIComponent(subjMatch[1]);
    const s = SUBJECTS[id];
    if (!s) return send(res, 404, { error: "subject not found" });
    const stories = STORIES.filter((st) => st.subjects.some((x) => x.id === id)).map(publicStory);
    return send(res, 200, { id, ...s, stories });
  }

  if (p === "/api/raw/events") {
    return send(res, 200, { items: Object.keys(EVENTS).map(withId), nextCursor: null });
  }

  if (p === "/rss.xml") {
    const items = STORIES.map((s) => `<item><title>${s.headline}</title><guid>${s.id}</guid><description>${s.body}</description></item>`).join("");
    return send(res, 200, `<?xml version="1.0"?><rss version="2.0"><channel><title>On Record</title>${items}</channel></rss>`, "application/rss+xml");
  }

  send(res, 404, { error: "not found" });
}).listen(PORT, () => {
  console.log(`mock On Record API on http://localhost:${PORT}  (${STORIES.length} demo stories)`);
});
