'use client'

import { Slab, Dot, Line, Label, Chevron } from './primitives'
import type { Palette } from './palette'

// Stylized 3D copy of the Reconix window, laid out like src/renderer/src/App.tsx:
// tab bar, toolbar, sitemap/findings sidebar, the page under test with DevTools below it,
// the copilot on the right, and the status bar. Units: the window is 10 x 6.4.
// Ids on Slabs are focus targets referenced from lib/narrative.ts.

export default function Model({ p }: { p: Palette }) {
  return (
    <Slab w={10} h={6.4} d={0.2} r={0.22} color={p.window}>
      <TabBar p={p} />
      <Toolbar p={p} />
      <Sidebar p={p} />
      <Viewport p={p} />
      <DevTools p={p} />
      <Copilot p={p} />
      <StatusBar p={p} />
    </Slab>
  )
}

function TabBar({ p }: { p: Palette }) {
  const tabs = [
    { x: -3.05, label: 'target.test/login', active: true },
    { x: -1.37, label: 'api/users', active: false },
    { x: 0.31, label: 'Repeater', active: false }
  ]
  return (
    <group position={[0, 2.93, 0]}>
      <Dot x={-4.7} size={0.13} color={p.critical} />
      <Dot x={-4.48} size={0.13} color={p.medium} />
      <Dot x={-4.26} size={0.13} color={p.success} />
      {tabs.map((t) => (
        <Slab key={t.label} x={t.x} w={1.6} h={0.36} d={t.active ? 0.03 : 0.015} r={0.07} color={t.active ? p.surfaceHi : p.surfaceLo}>
          <Slab x={-0.62} w={0.12} h={0.12} d={0.01} r={0.03} color={t.active ? p.accent : p.bar} />
          <Label x={-0.5} y={0} size={0.1} color={t.active ? p.text : p.textMuted}>{t.label}</Label>
        </Slab>
      ))}
      <Slab x={1.36} w={0.26} h={0.26} d={0.015} r={0.06} color={p.surfaceLo}>
        <Slab w={0.12} h={0.025} d={0.006} r={0.01} color={p.textMuted} />
        <Slab w={0.025} h={0.12} d={0.006} r={0.01} color={p.textMuted} />
      </Slab>
    </group>
  )
}

function Toolbar({ p }: { p: Palette }) {
  return (
    <group position={[0, 2.45, 0]}>
      <Slab x={-4.7} w={0.24} h={0.24} d={0.025} r={0.12} color={p.surfaceHi}>
        <Chevron dir="left" color={p.text} />
      </Slab>
      <Slab x={-4.4} w={0.24} h={0.24} d={0.025} r={0.12} color={p.surfaceHi}>
        <Chevron dir="right" color={p.textFaint} />
      </Slab>
      <Slab x={-4.1} w={0.24} h={0.24} d={0.025} r={0.12} color={p.surfaceHi}>
        {/* Reload: a ring with a gap, drawn as a dot inside a ring. */}
        <Slab w={0.11} h={0.11} d={0.006} r={0.055} color={p.text}>
          <Slab w={0.06} h={0.06} d={0.004} r={0.03} color={p.surfaceHi} />
        </Slab>
      </Slab>
      <Slab x={-0.55} w={6.3} h={0.34} d={0.02} r={0.17} color={p.inset}>
        <Slab x={-2.95} w={0.08} h={0.1} d={0.008} r={0.02} color={p.textMuted} />
        <Label x={-2.83} y={0} size={0.115} color={p.text}>https://target.test/login</Label>
        <Slab id="scope-url" x={2.68} w={0.78} h={0.22} d={0.02} r={0.11} color={p.accentSoft} lift={0.3}>
          <Label x={0} y={0} size={0.085} anchor="center" color={p.onAccentSoft}>In scope</Label>
        </Slab>
      </Slab>
      {/* Sidebar, DevTools, and Copilot toggles: a frame with the toggled pane filled in. */}
      {[
        { x: 3.62, pane: { x: -0.035, y: 0, w: 0.035, h: 0.1 }, on: false },
        { x: 4.0, pane: { x: 0, y: -0.025, w: 0.12, h: 0.035 }, on: false },
        { x: 4.38, pane: { x: 0.035, y: 0, w: 0.035, h: 0.1 }, on: true }
      ].map((b) => (
        <Slab key={b.x} x={b.x} w={0.28} h={0.28} d={0.025} r={0.06} color={b.on ? p.accent : p.surfaceHi}>
          <Slab w={0.15} h={0.13} d={0.005} r={0.025} color={b.on ? p.onAccent : p.textMuted}>
            <Slab w={0.12} h={0.1} d={0.003} r={0.015} color={b.on ? p.accent : p.surfaceHi}>
              <Slab x={b.pane.x} y={b.pane.y} w={b.pane.w} h={b.pane.h} d={0.003} r={0.008} color={b.on ? p.onAccent : p.textMuted} />
            </Slab>
          </Slab>
        </Slab>
      ))}
    </group>
  )
}

function Sidebar({ p }: { p: Palette }) {
  const rows = [
    { indent: 0, w: 0.9, label: 'target.test' },
    { indent: 1, w: 0.7, label: 'login' },
    { indent: 1, w: 0.6, label: 'api' },
    { indent: 2, w: 0.7, label: 'users' },
    { indent: 2, w: 0.55, label: 'session' },
    { indent: 1, w: 0.75, label: 'static' }
  ]
  const findings = [
    { sev: p.critical, title: 'Reflected XSS in email', w: 1.0 },
    { sev: p.high, title: 'IDOR on /api/users/:id', w: 0.8 },
    { sev: p.medium, title: 'Missing CSRF token', w: 0.9 }
  ]
  return (
    <Slab x={-3.93} y={-0.36} w={1.94} h={5.08} d={0.035} r={0.1} color={p.surfaceLo}>
      <Label x={-0.8} y={2.28} size={0.115} color={p.text}>Sitemap</Label>
      <Slab x={0.78} y={2.28} w={0.12} h={0.12} d={0.01} r={0.03} color={p.bar} />
      {rows.map((row, i) => {
        const y = 1.96 - i * 0.27
        const x = -0.8 + row.indent * 0.16
        const content = (
          <>
            <Slab x={x + 0.05} y={i === 3 ? 0 : y} w={0.1} h={0.1} d={0.008} r={0.02} color={i === 3 ? p.accent : p.bar} />
            <Label x={x + 0.15} y={i === 3 ? 0 : y} size={0.095} color={i === 3 ? p.text : p.textMuted}>{row.label}</Label>
          </>
        )
        return i === 3 ? (
          <Slab key={row.label} id="site-3" y={y} w={1.78} h={0.24} d={0.015} r={0.05} color={p.surfaceHi} lift={0.1}>
            {content}
          </Slab>
        ) : (
          <group key={row.label}>{content}</group>
        )
      })}
      <Label x={-0.8} y={0.18} size={0.115} color={p.text}>Findings</Label>
      <Label x={0.84} y={0.18} size={0.095} anchor="right" color={p.textFaint}>3</Label>
      {findings.map((f, i) => (
        <Slab key={f.title} id={`finding-${i}`} y={-0.2 - i * 0.54} w={1.78} h={0.46} d={0.03} r={0.06} color={p.surfaceHi}>
          <Dot x={-0.74} y={0.09} size={0.1} color={f.sev} d={0.012} />
          <Label x={-0.63} y={0.09} size={0.09} color={p.text}>{f.title}</Label>
          <Line x={-0.79} y={-0.1} w={f.w} color={p.bar} h={0.05} />
        </Slab>
      ))}
      <Line x={-0.8} y={-1.95} w={1.2} color={p.bar} h={0.05} />
      <Line x={-0.8} y={-2.1} w={0.8} color={p.bar} h={0.05} />
    </Slab>
  )
}

function Viewport({ p }: { p: Palette }) {
  return (
    <Slab x={-0.125} y={0.62} w={5.47} h={3.08} d={0.03} r={0.08} color={p.page}>
      {/* The page under test: a plain login screen. */}
      <group position={[0, 1.22, 0]}>
        <Slab x={-2.35} w={0.24} h={0.24} d={0.02} r={0.06} color={p.ink} />
        <Line x={-1.95} y={0} w={0.34} color={p.pageBar} />
        <Line x={-1.48} y={0} w={0.4} color={p.pageBar} />
        <Line x={-0.95} y={0} w={0.3} color={p.pageBar} />
        <Slab x={2.25} w={0.62} h={0.24} d={0.02} r={0.04} color={p.input}>
          <Line x={-0.18} y={0} w={0.36} h={0.04} color={p.pageFaint} />
        </Slab>
      </group>
      <Slab y={-0.2} w={2.3} h={2.0} d={0.04} r={0.08} color={p.pageCard}>
        <Label x={-0.95} y={0.7} size={0.16} color={p.pageText}>Sign in</Label>
        <Line x={-0.95} y={0.5} w={1.25} h={0.05} color={p.pageBar} />
        <Slab id="input-email" y={0.13} w={1.98} h={0.4} d={0.012} r={0.08} color={p.accent} lift={0.22}>
          <Slab w={1.9} h={0.32} d={0.015} r={0.05} color={p.input}>
            <Label x={-0.85} y={0} size={0.095} color={p.pageFaint}>you@company.com</Label>
          </Slab>
        </Slab>
        <Slab y={-0.3} w={1.9} h={0.32} d={0.015} r={0.05} color={p.input}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Dot key={i} x={-0.83 + i * 0.09} size={0.05} d={0.006} color={p.pageFaint} />
          ))}
        </Slab>
        <Slab y={-0.72} w={1.9} h={0.32} d={0.025} r={0.05} color={p.ink}>
          <Label x={0} y={0} size={0.105} anchor="center" color={p.onInk}>Continue</Label>
        </Slab>
      </Slab>
    </Slab>
  )
}

function DevTools({ p }: { p: Palette }) {
  const tabs = ['Elements', 'Network', 'Intercept', 'Repeater', 'WebSocket', 'Console']
  const rows = [
    { m: 'GET', path: '/login', s: '200', sc: p.success, t: 0.5 },
    { m: 'POST', path: '/api/session', s: '302', sc: p.medium, t: 0.8 },
    { m: 'POST', path: '/api/users', s: '403', sc: p.critical, t: 0.35 },
    { m: 'GET', path: '/static/app.js', s: '200', sc: p.success, t: 1.1 },
    { m: 'PUT', path: '/api/users/42', s: '200', sc: p.success, t: 0.6 }
  ]
  return (
    <Slab x={-0.125} y={-1.97} w={5.47} h={1.94} d={0.035} r={0.08} color={p.surfaceLo}>
      {tabs.map((t, i) => {
        const x = -2.45 + i * 0.78
        return t === 'Network' ? (
          <Slab key={t} id="tab-network" x={x + 0.3} y={0.74} w={0.74} h={0.24} d={0.02} r={0.05} color={p.surfaceHi} lift={0.1}>
            <Label x={0} y={0.01} size={0.09} anchor="center" color={p.text}>{t}</Label>
            <Slab y={-0.1} w={0.5} h={0.025} d={0.006} r={0.01} color={p.accent} />
          </Slab>
        ) : (
          <Label key={t} x={x} y={0.74} size={0.09} color={p.textMuted}>{t}</Label>
        )
      })}
      <Slab y={0.58} w={5.3} h={0.012} d={0.004} r={0.004} color={p.line} />
      {rows.map((row, i) => {
        const y = 0.36 - i * 0.27
        const content = (
          <>
            <Slab x={-2.38} y={0} w={0.42} h={0.16} d={0.012} r={0.08} color={row.m === 'GET' ? p.surfaceHi : p.accentSoft}>
              <Label x={0} y={0} size={0.075} anchor="center" color={row.m === 'GET' ? p.textMuted : p.onAccentSoft}>{row.m}</Label>
            </Slab>
            <Label x={-2.06} y={0} size={0.09} color={p.text}>{row.path}</Label>
            <Dot x={0.6} y={0} size={0.08} d={0.008} color={row.sc} />
            <Label x={0.7} y={0} size={0.09} color={p.textMuted}>{row.s}</Label>
            <Line x={1.3} y={0} w={row.t} h={0.06} color={p.bar} />
          </>
        )
        return i === 2 ? (
          <Slab key={row.path + i} id="net-2" y={y} w={5.28} h={0.24} d={0.012} r={0.05} color={p.surfaceHi} lift={0.14}>
            {content}
          </Slab>
        ) : (
          <group key={row.path + i} position={[0, y, 0]}>{content}</group>
        )
      })}
    </Slab>
  )
}

function Copilot({ p }: { p: Palette }) {
  return (
    <Slab x={3.795} y={-0.36} w={2.21} h={5.08} d={0.035} r={0.1} color={p.surfaceLo}>
      <Label x={-0.92} y={2.28} size={0.115} color={p.text}>Copilot</Label>
      <Slab x={0.72} y={2.28} w={0.5} h={0.18} d={0.012} r={0.09} color={p.surfaceHi}>
        <Label x={0} y={0} size={0.075} anchor="center" color={p.textMuted}>vLLM</Label>
      </Slab>

      <Slab x={0.2} y={1.86} w={1.6} h={0.36} d={0.02} r={0.08} color={p.surfaceHi}>
        <Label x={-0.7} y={0} size={0.085} color={p.text}>Check the login form for XSS</Label>
      </Slab>

      <Label x={-0.95} y={1.42} size={0.085} maxWidth={1.9} color={p.textMuted}>
        The email field is echoed back unescaped on a failed sign in. Likely reflected XSS.
      </Label>

      <Slab id="code" y={0.62} w={1.98} h={0.72} d={0.03} r={0.05} color={p.codeBg} lift={0.2}>
        {[
          [0.3, 0.6, 0.4],
          [0.5, 0.35],
          [0.2, 0.7, 0.3],
          [0.45, 0.5]
        ].map((segs, row) => {
          let cx = -0.86
          return segs.map((w, k) => {
            const el = <Line key={`${row}-${k}`} x={cx} y={0.22 - row * 0.15} w={w} h={0.05} color={p.syntax[(row + k) % p.syntax.length]} />
            cx += w + 0.06
            return el
          })
        })}
      </Slab>

      <Slab id="approval" y={-0.55} w={1.98} h={1.22} d={0.04} r={0.07} color={p.surfaceHi} lift={0.26}>
        <Dot x={-0.82} y={0.4} size={0.1} d={0.012} color={p.high} />
        <Label x={-0.7} y={0.4} size={0.1} color={p.text}>Approval needed</Label>
        <Label x={-0.88} y={0.16} size={0.08} color={p.textMuted}>POST /api/users  role=admin</Label>
        <Line x={-0.88} y={-0.02} w={1.45} h={0.05} color={p.bar} />
        <Slab id="btn-approve" x={-0.46} y={-0.35} w={0.84} h={0.3} d={0.03} r={0.05} color={p.accent} lift={0.08}>
          <Label x={0} y={0} size={0.095} anchor="center" color={p.onAccent}>Approve</Label>
        </Slab>
        <Slab x={0.46} y={-0.35} w={0.84} h={0.3} d={0.02} r={0.05} color={p.surfaceLo}>
          <Label x={0} y={0} size={0.095} anchor="center" color={p.text}>Deny</Label>
        </Slab>
      </Slab>

      <Slab y={-2.12} w={1.98} h={0.5} d={0.02} r={0.08} color={p.inset}>
        <Label x={-0.85} y={0} size={0.09} color={p.textFaint}>Ask the copilot</Label>
        {/* Send: an up arrow, a short stem under a chevron turned to point up. */}
        <Slab x={0.78} w={0.28} h={0.28} d={0.025} r={0.14} color={p.ink}>
          <Slab y={-0.015} w={0.022} h={0.1} d={0.006} r={0.011} color={p.onInk} />
          <group position={[0, 0.03, 0]} rotation={[0, 0, -Math.PI / 2]}>
            <Chevron dir="left" color={p.onInk} />
          </group>
        </Slab>
      </Slab>
    </Slab>
  )
}

function StatusBar({ p }: { p: Palette }) {
  return (
    <group position={[0, -3.06, 0]}>
      <Dot x={-4.74} size={0.08} d={0.01} color={p.success} />
      <Label x={-4.64} y={0} size={0.085} color={p.textMuted}>Engine ready</Label>
      <Label x={-3.6} y={0} size={0.085} color={p.textMuted}>142 requests</Label>
      <Label x={2.9} y={0} size={0.085} anchor="right" color={p.textMuted}>4,812 tokens</Label>
      <Slab id="scope-status" x={4.22} w={1.24} h={0.2} d={0.02} r={0.1} color={p.accentSoft} lift={0.3}>
        <Label x={0} y={0} size={0.075} anchor="center" color={p.onAccentSoft}>Scope: target.test</Label>
      </Slab>
    </group>
  )
}
