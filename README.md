# tronmix

TRON network traffic over the [Nym mixnet](https://nym.com). TRON carries most of the world's USDT transfers, and
almost every TRON wallet and script asks the same public API (TronGrid) for balances, resources and transaction
status, then broadcasts through it. That log ties your IP to your addresses and to the exact moment you paid.
tronmix routes every request through the mixnet (Nym `mix-fetch` v3 / smolmix, via an IP Packet Router exit), so
`api.trongrid.io` sees a Nym exit node, not you.

- **CLI**: `info`, `balance <addr>` (TRX + TRC-20 incl. USDT), `resources <addr>` (bandwidth / energy before you
  send), `tx <txid>`, `broadcast <signed-json|hex|@file>`
- **Local gateway**: `proxy [port]` serves `http://127.0.0.1:8090`. Point TronWeb (`fullHost`) or a wallet's custom
  node URL at it instead of `https://api.trongrid.io`. Both `/wallet/*` and `/v1/*` endpoints pass through.
- **No clearnet fallback**: if the tunnel fails, the request fails.

## Run

Needs [Deno](https://deno.com) 2.x. Nothing else to install; Deno fetches the npm packages.

```sh
deno run -A --node-modules-dir=none --deny-net=api.trongrid.io tronmix.ts info
deno run -A --node-modules-dir=none --deny-net=api.trongrid.io tronmix.ts balance TGfpDQFYmnfMJZuoB1RzBLTLGKrGYRq79T
deno run -A --node-modules-dir=none --deny-net=api.trongrid.io tronmix.ts proxy 8090
curl http://127.0.0.1:8090/v1/accounts/TGfpDQFYmnfMJZuoB1RzBLTLGKrGYRq79T
```

```js
// TronWeb over the mixnet
const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1:8090' });
```

The first call opens the tunnel (about 5-10 s). Small requests then take about 1-3 s; large responses (a full block
from `/wallet/getnowblock`) can take tens of seconds.

Env: `TRONMIX_API` for another host (your own java-tron node, or Shasta/Nile testnet), `TRON_PRO_API_KEY` if you
have a TronGrid key (it is sent through the mixnet; note that a key is itself an identifier), `TRONMIX_DEBUG=1` for
tunnel logs.

## Proof it doesn't touch the clearnet

`--deny-net=api.trongrid.io` tells Deno's sandbox to refuse **any** direct connection from this process to the API
host. The commands still succeed, so the bytes must have gone through the Nym gateway websocket. The code never
calls `fetch` directly. Check it yourself:

```sh
deno run -A --node-modules-dir=none --deny-net=api.trongrid.io deny_check.ts       # -> NotCapable error
deno run -A --node-modules-dir=none --deny-net=api.trongrid.io tronmix.ts info     # -> works, via mixnet
```

Tested 2026-11-09 on Windows 11, Deno 2, mainnet, with direct access denied: `info`, `balance`, `resources`, `tx`,
`broadcast` (a malformed tx, to see the node's rejection come back through the tunnel), and the gateway for
`POST /wallet/getnowblock` and `GET /v1/accounts/<addr>`.

## Gateway hardening

- binds to `127.0.0.1` only
- forwards only to the configured API host (the path is appended to it; you can't pick another host)
- strips `cookie`, `user-agent`, `origin`, `referer`, `x-forwarded-for` before the request leaves

## Limits

- The API provider still sees *what* you ask about (addresses, txids). It just can't tie it to your IP. For full
  privacy, run your own node and point `TRONMIX_API` at it over the mixnet.
- Speed: mixnet latency plus cover traffic. Fine for wallet use, slow for indexing.
- Deno shims (forced module Worker, in-worker `fake-indexeddb`) work around mix-fetch v3 targeting browsers.

## License

MIT · built by Tessel Works for Build with Nym (Fall 2026)
