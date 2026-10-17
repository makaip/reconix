# Egress proxy (Reconix 5.D — the smart wall)

The scope-enforcing forward proxy. Every byte the OpenCode container sends
outward is meant to traverse this process; the nftables floor
(`infra/nftables/`) drops anything that tries to route around it.

## What it enforces

- Loads the **same** `ScopeConfig` the per-tool `ScopeChecker` uses
  (`src/shared/scope.ts` shape), compiles it with the **same** compiler
  (`compileScope` in `src/main/scope.ts`), and decides with the **same** matcher
  (`evaluateProxyRules`). Proxy and checker therefore give identical verdicts.
- **Default deny.** The compiled rule list ends in a catch-all deny. In scope →
  forward + `decision:"allow"` log line. Anything else → drop + `decision:"deny"`.
- The **model endpoint** is listed in `ScopeConfig.infra`, so it compiles to an
  explicit allow rule ahead of the catch-all — the container can reach inference
  over an internal address, never the open internet.
- **Rate limiter** (token bucket, per target host). Scope bounds *where* traffic
  goes; the limiter bounds *how hard* it hits an in-scope host. `SAFE_TO_POUND`
  is **off by default** (conservative: 1 req/sec/target). A human flips it on and
  raises `RATE_RPS_PER_TARGET` only for a target confirmed safe to hammer.

## Honest limitation (HTTPS CONNECT)

For plaintext HTTP the proxy sees the full URL and enforces host + port + **path
prefix**. For HTTPS the client issues `CONNECT host:port` and the body is TLS —
the path is invisible, so only **host + port** are enforced on the tunnel. If a
target needs path-level containment under TLS, scope it tightly by port/host or
terminate TLS at the proxy (not done here). The nftables floor is address-based
and backstops both.

## Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `SCOPE_CONFIG_PATH` | `/etc/reconix/scope.json` | ScopeConfig JSON to compile |
| `PROXY_LISTEN_HOST` | `0.0.0.0` | bind addr **inside the container network only** |
| `PROXY_LISTEN_PORT` | `8888` | proxy listen port |
| `SAFE_TO_POUND` | `false` | human gate; `true` raises the default cap |
| `RATE_RPS_PER_TARGET` | `1` (off) / `50` (on) | token refill rate per target |
| `RATE_BURST` | `= rps` | bucket depth |

A `scope.json` matching `src/shared/scope.ts` must be mounted at
`SCOPE_CONFIG_PATH`. See `infra/scope.example.json`.

## How it runs from compose

`docker-compose.yml` builds it as the `egress-proxy` service with
**`build.context: .`** (repo root) so the Dockerfile can copy the single-source
compiler from `src/`. The OpenCode service points `HTTP_PROXY` / `HTTPS_PROXY`
at `http://egress-proxy:8888` and has no other route out. The proxy port is
**not** published to the host — it is reachable only on the internal compose
network.

Run the whole stack:

```sh
docker compose up --build
```

## Local dev (no container)

```sh
SCOPE_CONFIG_PATH=infra/scope.example.json \
  npx tsx infra/proxy/server.ts
# then: curl -x http://127.0.0.1:8888 http://in-scope-host/...
```
