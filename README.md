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

## Use your own node

With the default host, TronGrid no longer sees your IP, but it still logs *which* addresses and txids are asked
about. To remove that third party, run a [java-tron](https://github.com/tronprotocol/java-tron) FullNode yourself.

**A. Node on a server (VPS or home server), queried over the mixnet.** Nobody else logs your lookups, and the
server only ever sees a Nym exit, so a compromised box or its hosting provider still can't tie the lookups to the
IP you browse from.

1. Run a java-tron FullNode (mainnet needs a full sync or a snapshot, and a lot of disk). Its HTTP API listens on
   port 8090 by default.
2. Put it behind HTTPS on port 443 (Caddy or nginx with a certificate for e.g. `tron.example.org`). Nym exit
   gateways apply an exit policy, and standard HTTPS is the safe choice. Don't expose port 8090 itself.
3. Point tronmix at it, and deny direct access to that host as well, so the sandbox check still proves that
   nothing leaves outside the mixnet:

```sh
TRONMIX_API=https://tron.example.org \
  deno run -A --node-modules-dir=none --deny-net=tron.example.org,api.trongrid.io tronmix.ts proxy 8090
```

A plain FullNode serves the `/wallet/*` API (`info`, `resources`, `tx`, `broadcast` and TronWeb's calls).
The `/v1/*` endpoints, which `balance` uses, are TronGrid's own indexer and **don't exist on java-tron**. With your
own node, read TRX balances with `POST /wallet/getaccount` and TRC-20 balances (USDT) with
`/wallet/triggerconstantcontract` calling `balanceOf`, which is what TronWeb's `contract().balanceOf()` does.

**B. Node on the same machine as the wallet.** Reads are local (`http://127.0.0.1:8090`), so you don't need the
mixnet for them. Broadcasts are a different story: a transaction your node relays first is gossiped from *your*
node's IP. To keep the "who paid" link off the network, read from the local node and send the signed transaction
through tronmix with the default host:

```sh
deno run -A --node-modules-dir=none --deny-net=api.trongrid.io tronmix.ts broadcast @signed-tx.json
```

## Limits

- With the default host, the API provider still sees *what* you ask about (addresses, txids). It just can't tie
  that to your IP. See [Use your own node](#use-your-own-node) to remove the provider.
- Speed: mixnet latency plus cover traffic. Fine for wallet use, slow for indexing.
- Deno shims (forced module Worker, in-worker `fake-indexeddb`) work around mix-fetch v3 targeting browsers.

## License

MIT · built by Tessel Works for Build with Nym (Fall 2026)
