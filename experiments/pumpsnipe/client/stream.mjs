// The detector's transport. One launch feed, three backends.
//
// The fast one is not available on this account. Measured, not assumed:
//
//   laserstream  gRPC          "Unsupported plan type"   Business, $499/mo
//   atlas        transactionSubscribe   HTTP 403         Developer, $49/mo
//   ws           logsSubscribe          works            free
//
// So `ws` is the default and the other two are wired up behind an env switch,
// ready if the plan changes. All three normalise to the same launch object, so
// nothing downstream knows or cares which one is running.
//
//   TRANSPORT=ws|atlas|laserstream   (default ws)
//   HELIUS_API_KEY=...
//   LASERSTREAM_ENDPOINT=https://laserstream-mainnet-ewr.helius-rpc.com

import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import './env.mjs';
import { launchFromLogs } from './events.mjs';
import { PUMP } from './lift.mjs';

const KEY = process.env.HELIUS_API_KEY;

/** Normalise whatever the backend hands us into log lines + a signature. */
function emit(logs, signature, slot, onLaunch) {
  if (!logs?.length) return;
  const launch = launchFromLogs(logs, PUMP);
  if (!launch) return;
  onLaunch({ ...launch, signature, slot, seenAt: Date.now() });
}

const b58 = (x) => {
  if (!x) return null;
  if (typeof x === 'string') return x;
  try { return new PublicKey(Buffer.from(x)).toBase58(); } catch { return null; }
};

/** Free tier. Logs only — which is all we need, since the event is in them. */
function startWs(onLaunch, onError) {
  const url = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
  let ws, alive = true, pingTimer;

  const connect = () => {
    ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMP.toBase58()] }, { commitment: 'processed' }],
      }));
      // Helius drops idle sockets; a launch gap longer than the timeout is
      // normal at 3am and we do not want to be silently unsubscribed.
      pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 20_000);
    });
    ws.on('message', (m) => {
      let j;
      try { j = JSON.parse(m); } catch { return; }
      if (j.error) return onError(new Error(JSON.stringify(j.error)));
      const v = j.params?.result?.value;
      if (!v || v.err) return;
      emit(v.logs, v.signature, j.params.result.context?.slot, onLaunch);
    });
    ws.on('error', (e) => onError(e));
    ws.on('close', () => {
      clearInterval(pingTimer);
      if (alive) setTimeout(connect, 1_000);
    });
  };
  connect();
  return () => { alive = false; clearInterval(pingTimer); try { ws.close(); } catch {} };
}

/** Developer tier and up. Full transaction in the stream. */
function startAtlas(onLaunch, onError) {
  const url = `wss://atlas-mainnet.helius-rpc.com/?api-key=${KEY}`;
  let ws, alive = true, pingTimer;

  const connect = () => {
    ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'transactionSubscribe',
        params: [
          { accountInclude: [PUMP.toBase58()], failed: false, vote: false },
          {
            commitment: 'processed', encoding: 'jsonParsed',
            transactionDetails: 'full', showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      }));
      pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 20_000);
    });
    ws.on('message', (m) => {
      let j;
      try { j = JSON.parse(m); } catch { return; }
      if (j.error) return onError(new Error(JSON.stringify(j.error)));
      const r = j.params?.result;
      if (!r) return;
      emit(r.transaction?.meta?.logMessages, r.signature, r.slot, onLaunch);
    });
    ws.on('error', (e) => onError(e));
    ws.on('close', () => {
      clearInterval(pingTimer);
      if (alive) setTimeout(connect, 1_000);
    });
  };
  connect();
  return () => { alive = false; clearInterval(pingTimer); try { ws.close(); } catch {} };
}

/** Business tier and up. The one you actually want; reconnects itself. */
async function startLaserstream(onLaunch, onError) {
  const { subscribe, CommitmentLevel } = await import('helius-laserstream');
  const endpoint = process.env.LASERSTREAM_ENDPOINT
    ?? 'https://laserstream-mainnet-ewr.helius-rpc.com';

  const req = {
    transactions: {
      pump: {
        accountInclude: [PUMP.toBase58()], accountExclude: [], accountRequired: [],
        vote: false, failed: false,
      },
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {}, slots: {}, blocks: {}, blocksMeta: {}, entry: {},
    accountsDataSlice: [], transactionsStatus: {},
  };

  const stream = await subscribe({ apiKey: KEY, endpoint }, req,
    async (d) => {
      const t = d.transaction;
      if (!t) return;
      const inner = t.transaction ?? t;
      const logs = (inner.meta?.logMessages ?? []).map(
        (l) => (typeof l === 'string' ? l : Buffer.from(l).toString('utf8')));
      emit(logs, b58(inner.signature), Number(t.slot ?? 0), onLaunch);
    },
    async (e) => onError(e));

  return () => { try { stream?.cancel?.(); } catch {} };
}

/**
 * Start the launch feed. Calls onLaunch once per pump.fun token creation with
 * a decoded CreateEvent plus `seenAt`.
 */
export async function watchLaunches(onLaunch, onError = (e) => console.error('stream:', e?.message ?? e)) {
  const transport = process.env.TRANSPORT ?? 'ws';
  if (!KEY) throw new Error('HELIUS_API_KEY is not set');
  if (transport === 'laserstream') return startLaserstream(onLaunch, onError);
  if (transport === 'atlas') return startAtlas(onLaunch, onError);
  if (transport === 'ws') return startWs(onLaunch, onError);
  throw new Error(`unknown TRANSPORT ${transport}`);
}

export const TRANSPORT = process.env.TRANSPORT ?? 'ws';
