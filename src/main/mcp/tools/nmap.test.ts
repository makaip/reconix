// nmap_scan: the XML parser and hostile-input guards are pure, so they are
// pinned here (the spawn path needs a real nmap binary; the ENOENT path is
// covered by the handler's error message, not a test).
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { parseNmapXml, nmapTools, type NmapInput } from './nmap'
import type { Tool, ToolContext } from '../tool'

const tool = nmapTools[0] as Tool<NmapInput, Record<string, unknown>>

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap" args="nmap -sV -p 22,80 --open -oX - 10.0.0.5">
<host starttime="1" endtime="2">
<status state="up" reason="syn-ack"/>
<address addr="10.0.0.5" addrtype="ipv4"/>
<hostnames>
<hostname name="app.internal" type="user"/>
<hostname name="app.example.com" type="PTR"/>
</hostnames>
<ports>
<extraports state="closed" count="996">
<extrareasons reason="reset" count="996"/>
</extraports>
<port protocol="tcp" portid="22">
<state state="open" reason="syn-ack" reason_ttl="64"/>
<service name="ssh" product="OpenSSH" version="8.2p1 Ubuntu 4ubuntu0.9" extrainfo="Ubuntu Linux; protocol 2.0" method="probed" conf="10"/>
</port>
<port protocol="tcp" portid="80">
<state state="open" reason="syn-ack" reason_ttl="64"/>
<service name="http" product="nginx" version="1.18.0" tunnel="ssl"/>
</port>
</ports>
<os>
<osmatch name="Linux 5.4 - 5.15" accuracy="98" line="12345">
<osclass type="general purpose" vendor="Linux" osfamily="Linux" osgen="5.X"/>
</osmatch>
</os>
</host>
</nmaprun>`

describe('parseNmapXml', () => {
  it('extracts the user-supplied hostname, open ports, service versions and OS', () => {
    const scan = parseNmapXml(XML, 'fallback.host')
    expect(scan.host).toBe('app.internal')
    expect(scan.address).toBe('10.0.0.5')
    expect(scan.ports).toEqual([
      {
        port: 22,
        protocol: 'tcp',
        state: 'open',
        service: 'ssh',
        version: 'OpenSSH 8.2p1 Ubuntu 4ubuntu0.9 Ubuntu Linux; protocol 2.0'
      },
      { port: 80, protocol: 'tcp', state: 'open', service: 'http', version: 'nginx 1.18.0' }
    ])
    expect(scan.os).toEqual({ name: 'Linux 5.4 - 5.15', accuracy: 98 })
    expect(scan.extraPorts).toEqual([{ state: 'closed', count: 996 }])
  })

  it('falls back to the address, then the caller-supplied host', () => {
    expect(parseNmapXml('<host><address addr="10.0.0.9" addrtype="ipv4"/></host>', 'x.test').host).toBe(
      '10.0.0.9'
    )
    const bare = parseNmapXml('<nmaprun></nmaprun>', 'x.test')
    expect(bare.host).toBe('x.test')
    expect(bare.ports).toEqual([])
    expect(bare.os).toBeUndefined()
  })

  it('decodes XML entities in hostnames', () => {
    const scan = parseNmapXml('<hostname name="a&amp;b.test" type="user"/>', 'x.test')
    expect(scan.host).toBe('a&b.test')
  })
})

describe('nmap_scan input validation', () => {
  it('accepts a plain host and normalizes optional fields', () => {
    expect(tool.parse({ host: '10.0.0.5' })).toEqual({
      host: '10.0.0.5',
      ports: undefined,
      serviceVersion: false,
      scripts: undefined
    })
  })

  it('rejects ranges, CIDR blocks and lists', () => {
    for (const host of ['10.0.0.1-254', '10.0.0.0/24', 'a.test,b.test', '-oN', 'a test']) {
      expect(() => tool.parse({ host })).toThrow(/"host"/)
    }
  })

  it('rejects non-nmap port specs and flag-shaped script names', () => {
    expect(() => tool.parse({ host: 'a.test', ports: '80; rm -rf /' })).toThrow(/"ports"/)
    expect(() => tool.parse({ host: 'a.test', scripts: ['--script-updatedb'] })).toThrow(/invalid script/)
  })
})

describe('nmap_scan scope handling', () => {
  const scopeCtx = (allowed: string[]): ToolContext =>
    ({
      scope: {
        config: { allowed_hosts: allowed, allowed_cidrs: [], denied: [], rate_limits: {} },
        isInScope: (t?: string) => allowed.includes(t ?? ''),
        assertInScope: () => undefined
      },
      traces: { save: async () => 'trace-1' }
    }) as unknown as ToolContext

  it('refuses a host outside the configured allowlist before spawning', async () => {
    const input = tool.parse({ host: 'evil.test' })
    await expect(tool.execute(input, scopeCtx(['app.test']))).rejects.toThrow(/out of scope/i)
  })

  // Runs for real only where nmap is absent (the common dev box); when nmap is
  // installed this asserts nothing and is skipped so CI doesn't depend on it.
  const hasNmap = spawnSync('nmap', ['--version'], { stdio: 'ignore' }).status === 0
  it.skipIf(hasNmap)('explains that nmap is missing instead of failing obscurely', async () => {
    const input = tool.parse({ host: '127.0.0.1' })
    // Empty scope -> the "no engagement scope loaded" path, so execute reaches spawn.
    await expect(tool.execute(input, scopeCtx([]))).rejects.toThrow(/not installed|not found on PATH/)
  })
})
