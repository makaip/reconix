# nftables floor (Reconix 5.D — the blunt wall)

The dumb L3/L4 wall behind the smart proxy. If the proxy is bypassed, this drops
any packet to a non-target address and kills DNS exfil and raw sockets. It
reasons about **addresses and ports only** — hostname/path logic is the proxy's
job (`infra/proxy/`). Both derive from the same compiled `CompiledScope`.

## RUNS INSIDE THE LINUX CONTAINER ONLY

> **The dev host is darwin (macOS) and has no nftables.** Do **not** run these
> rules on the host — `nft` does not exist there and the Mac's packet filter is
> `pf`, which this does not target. The ruleset is loaded in the Linux OpenCode
> container (or its network namespace) at startup, where `nft` exists.
>
> (On macOS at dev time the containment that matters is the compose network
> topology plus the proxy; the nftables floor is a container-runtime concern.)

Applying it needs `NET_ADMIN` on the container and an `nftables`-capable kernel.
It is intentionally **not** wired into `docker compose up` by default (it needs
elevated caps and a resolver/CIDR tuned per deployment); load it as a container
entrypoint step once those are set.

## Generating the ruleset

```sh
npx tsx infra/nftables/generate.ts <scope.json> [resolverIp] > reconix.nft
# example:
npx tsx infra/nftables/generate.ts infra/scope.example.json 127.0.0.11 > reconix.nft
```

`reconix.nft.example` is a checked-in sample of that output.

## What the ruleset does

- `policy drop` on the `output` chain — **deny by default**.
- loopback + established/related accepted (so replies to allowed flows work).
- DNS (`udp/tcp dport 53`) accepted **only** to the one configured resolver IP;
  every other `:53` packet is dropped and counted — this is where DNS exfil dies.
- one `accept` per in-scope **CIDR** target (from `CompiledScope.nftRules`) on its
  ports. Host-only (DNS-name) targets produce no rule here — their names are
  resolved and enforced at the proxy.
- a trailing `counter drop` mirroring the compiler's catch-all drop; anything not
  explicitly accepted (non-target addresses, raw sockets, other protocols) dies.

## Topology note

In the compose stack the OpenCode container's only real egress route is the
proxy service. So in practice the floor should accept **only** the proxy address
and the model endpoint CIDR and drop the rest — set the resolver and the
`infra`/target CIDRs in the ScopeConfig accordingly so the generated accepts
match that intent.
