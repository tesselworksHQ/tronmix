// tronmix: talk to the TRON network (TronGrid HTTP API) over the Nym mixnet.
// CLI:   deno run -A --node-modules-dir=none --deny-net=api.trongrid.io tronmix.ts <cmd> [args]
// Cmds:  info | balance <addr> | resources <addr> | tx <txid> | broadcast <hex|@file> | proxy [port]
// No clearnet fallback: every request goes through mixFetch; if the tunnel fails, the request fails.

// --- Deno shims for @nymproject/mix-fetch v3 (smolmix) -------------------------------------------
const _Worker = globalThis.Worker;
// deno-lint-ignore no-explicit-any
(globalThis as any).Worker = class extends _Worker {
  constructor(url: string | URL, opts?: WorkerOptions) { super(url, { ...(opts || {}), type: 'module' }); }
};
const _Blob = globalThis.Blob;
// deno-lint-ignore no-explicit-any
(globalThis as any).Blob = class extends _Blob {
  constructor(parts: BlobPart[] = [], opts?: BlobPropertyBag) {
    if (parts.every((p) => typeof p === 'string') && opts && /javascript/.test(opts.type || '')) {
      parts = ["import 'npm:fake-indexeddb@6/auto';\n", ...parts];
    }
    super(parts, opts);
  }
};

const { setupMixTunnel, mixFetch } = await import('npm:@nymproject/mix-fetch@3.0.1');

const API = Deno.env.get('TRONMIX_API') || 'https://api.trongrid.io';
const API_HOST = new URL(API).host;
const API_KEY = Deno.env.get('TRON_PRO_API_KEY') || '';
const quiet = Deno.env.get('TRONMIX_DEBUG') ? false : true;
const log = (...a: unknown[]) => console.error('[tronmix]', ...a);

let ready: Promise<void> | null = null;
function tunnel(): Promise<void> {
  if (!ready) {
    const t0 = Date.now();
    log('opening mixnet tunnel…');
    ready = setupMixTunnel({ debug: !quiet, iprAttemptTimeoutMs: 20000, iprMaxAttempts: 4, connectTimeoutMs: 60000 })
      .then(() => log(`tunnel up in ${Date.now() - t0} ms`));
  }
  return ready;
}

async function mf(path: string, init: RequestInit = {}): Promise<Response> {
  await tunnel();
  const headers = new Headers(init.headers || {});
  if (API_KEY && !headers.has('tron-pro-api-key')) headers.set('TRON-PRO-API-KEY', API_KEY);
  return await mixFetch(API + path, { ...init, headers });
}

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init: RequestInit = body === undefined ? {} : { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await mf(path, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const ADDR = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TXID = /^(0x)?[0-9a-fA-F]{64}$/;
function need(re: RegExp, v: string | undefined, what: string): string {
  if (!v || !re.test(v)) throw new Error(`expected a ${what}, got: ${v ?? '(nothing)'}`);
  return v;
}

const TRX = (sun: unknown) => (Number(sun ?? 0) / 1e6).toFixed(6) + ' TRX';
// Well-known TRC-20s, so the balance output is readable without extra contract calls.
const TOKENS: Record<string, [string, number]> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: ['USDT', 6],
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: ['USDC', 6],
  TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: ['WTRX', 6],
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: ['JST', 18],
  TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: ['SUN', 18],
};
const units = (raw: string, dec: number) => {
  const s = raw.padStart(dec + 1, '0');
  return dec ? `${s.slice(0, -dec)}.${s.slice(-dec)}` : s;
};

async function cli(cmd: string, args: string[]) {
  switch (cmd) {
    case 'info': {
      const b = await call('/wallet/getnowblock') as { blockID: string; block_header: { raw_data: Record<string, unknown> } };
      const raw = b.block_header.raw_data;
      console.log(JSON.stringify({ block: raw.number, block_id: b.blockID,
        timestamp: new Date(Number(raw.timestamp)).toISOString(), witness: raw.witness_address }, null, 2));
      break;
    }
    case 'balance': {
      const a = need(ADDR, args[0], 'TRON address (T…, base58)');
      const r = await call(`/v1/accounts/${a}`) as { data: Array<Record<string, unknown>> };
      const acct = r.data?.[0];
      if (!acct) { console.log('TRX       0.000000 TRX  (account not activated)'); break; }
      console.log(`TRX       ${TRX(acct.balance)}`);
      for (const entry of (acct.trc20 as Array<Record<string, string>>) || []) {
        for (const [contract, raw] of Object.entries(entry)) {
          const t = TOKENS[contract];
          console.log(t ? `TRC20     ${t[0].padEnd(5)} ${units(raw, t[1])}` : `TRC20     ${contract}  ${raw} (raw)`);
        }
      }
      break;
    }
    case 'resources': {
      const a = need(ADDR, args[0], 'TRON address');
      const r = await call('/wallet/getaccountresource', { address: a, visible: true }) as Record<string, number>;
      const freeNet = (r.freeNetLimit ?? 0) - (r.freeNetUsed ?? 0);
      const net = (r.NetLimit ?? 0) - (r.NetUsed ?? 0);
      const energy = (r.EnergyLimit ?? 0) - (r.EnergyUsed ?? 0);
      console.log(JSON.stringify({ bandwidth_free_left: freeNet, bandwidth_staked_left: net, energy_left: energy }, null, 2));
      break;
    }
    case 'tx': {
      const id = need(TXID, args[0], 'txid (64 hex)').replace(/^0x/, '');
      const [t, info] = await Promise.all([
        call('/wallet/gettransactionbyid', { value: id, visible: true }),
        call('/wallet/gettransactioninfobyid', { value: id }),
      ]);
      if (!t.txID) { console.log(JSON.stringify({ txID: id, status: 'not found (pending or unknown)' })); break; }
      const contract = ((t.raw_data as Record<string, unknown>)?.contract as Array<Record<string, unknown>>)?.[0];
      const ret = (t.ret as Array<Record<string, string>>)?.[0];
      console.log(JSON.stringify({ txID: t.txID, type: contract?.type, contract_ret: ret?.contractRet,
        block: info.blockNumber ?? null, confirmed: info.blockNumber !== undefined,
        fee_trx: info.fee !== undefined ? Number(info.fee) / 1e6 : 0,
        energy_used: (info.receipt as Record<string, number>)?.energy_usage_total ?? 0 }, null, 2));
      break;
    }
    case 'broadcast': {
      const src = args[0] ?? '';
      const data = (src.startsWith('@') ? await Deno.readTextFile(src.slice(1)) : src).trim();
      // A signed tx as JSON (tronweb output) goes to /wallet/broadcasttransaction; raw protobuf hex to /wallet/broadcasthex.
      const isJson = data.startsWith('{');
      if (!isJson && !/^([0-9a-fA-F]{2})+$/.test(data)) throw new Error('broadcast: expected signed tx JSON or hex');
      const r = isJson ? await call('/wallet/broadcasttransaction', JSON.parse(data))
                       : await call('/wallet/broadcasthex', { transaction: data });
      console.log(JSON.stringify(r));
      if (r.result !== true) Deno.exit(2);
      break;
    }
    case 'proxy': return proxy(Number(args[0] || 8090));
    default:
      console.log('usage: tronmix.ts info | balance <addr> | resources <addr> | tx <txid> | broadcast <hex|json|@file> | proxy [port]');
      Deno.exit(cmd ? 1 : 0);
  }
  Deno.exit(0);
}

// Local gateway: point TronWeb / a wallet at http://127.0.0.1:8090 instead of https://api.trongrid.io.
// Listens on loopback only; forwards only to the configured API host; strips identifying headers.
const DROP = new Set(['host', 'connection', 'cookie', 'origin', 'referer', 'user-agent', 'x-forwarded-for',
  'accept-encoding', 'content-length']);
async function proxy(port: number) {
  await tunnel();
  Deno.serve({ hostname: '127.0.0.1', port, onListen: () => log(`gateway http://127.0.0.1:${port} -> ${API_HOST} via mixnet`) },
    async (req) => {
      const u = new URL(req.url);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST' } });
      const headers = new Headers();
      for (const [k, v] of req.headers) if (!DROP.has(k.toLowerCase())) headers.set(k, v);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
      const t0 = Date.now();
      try {
        const r = await mf(u.pathname + u.search, { method: req.method, headers, body });
        const buf = new Uint8Array(await r.arrayBuffer());
        log(`${req.method} ${u.pathname} -> ${r.status} (${Date.now() - t0} ms)`);
        const h = new Headers({ 'content-type': r.headers.get('content-type') || 'application/json',
          'access-control-allow-origin': '*' });
        return new Response(buf, { status: r.status, headers: h });
      } catch (e) {
        log(`${req.method} ${u.pathname} -> mixnet error: ${e}`);
        return new Response(JSON.stringify({ error: 'mixnet request failed', detail: String(e) }), { status: 502 });
      }
    });
}

try {
  await cli(Deno.args[0] ?? '', Deno.args.slice(1));
} catch (e) {
  log('error:', e instanceof Error ? e.message : e);
  Deno.exit(1);
}
