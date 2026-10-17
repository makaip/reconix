// End-to-end smoke test: launches the app, opens a local page in a tab and checks that the
// chrome, tab manager, DevTools tree and request capture all work. Runs on every OS in CI.
//
//   node scripts/smoke.mjs              run the built app (npm run build first)
//   node scripts/smoke.mjs --packaged   run the app unpacked by `npm run pack`
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const packaged = process.argv.includes('--packaged')
const platform = process.platform
const outDir = resolve('smoke-output')

function packagedExecutable() {
  const release = resolve('release')
  const dirs = readdirSync(release).filter((name) => statSync(join(release, name)).isDirectory())
  const unpacked = dirs.find((name) => name.includes(platform === 'darwin' ? 'mac' : 'unpacked'))
  if (!unpacked) throw new Error(`No unpacked app found in ${release} (run npm run pack first)`)
  const root = join(release, unpacked)
  if (platform === 'darwin') return join(root, 'Reconix.app', 'Contents', 'MacOS', 'Reconix')
  const names = readdirSync(root)
  const exe = names.find((name) =>
    platform === 'win32' ? name.toLowerCase() === 'reconix.exe' : name.toLowerCase() === 'reconix'
  )
  if (!exe) throw new Error(`No executable in ${root}: ${names.join(', ')}`)
  return join(root, exe)
}

const server = createServer((request, response) => {
  if (request.url === '/app.css') {
    response.writeHead(200, { 'content-type': 'text/css' })
    response.end('.box { display: flex; gap: 8px; }')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(
    '<!doctype html><title>Smoke Page</title><link rel="stylesheet" href="/app.css">' +
      '<main id="app"><h1 class="box">Hello</h1></main>'
  )
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/`

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // set by some IDE terminals; it would run Electron as plain Node

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

let app
try {
  app = await electron.launch({
    ...(packaged ? { executablePath: packagedExecutable(), args: [] } : { args: ['.'] }),
    // the Linux CI sandbox has no setuid chrome-sandbox helper
    ...(platform === 'linux' ? { args: [...(packaged ? [] : ['.']), '--no-sandbox'] } : {}),
    env,
    timeout: 60_000
  })

  // tab views are windows too, so pick the app shell by its URL
  const shell = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const page = app.windows().find((w) => w.url().includes('renderer/index.html') || w.url().startsWith('http://localhost:5173'))
      if (page) return page
      await new Promise((done) => setTimeout(done, 200))
    }
    throw new Error('App window did not appear')
  })()

  await shell.waitForFunction(() => Boolean(window.reconix), null, { timeout: 15_000 })
  check('preload exposes window.reconix', true)

  const initial = await shell.evaluate(() => window.reconix.tabs.getState())
  check('starts with one blank tab', initial.tabs.length === 1 && initial.activeId === initial.tabs[0].id)

  check('chrome renders tab bar, toolbar and status bar', (await shell.locator('.tabbar, .toolbar, .statusbar').count()) === 3)

  const result = await shell.evaluate((target) => window.reconix.target.navigate(target), url)
  check('navigates the active tab', result.ok === true, JSON.stringify(result))

  await shell.waitForFunction(
    async () => (await window.reconix.tabs.getState()).tabs[0]?.title === 'Smoke Page',
    null,
    { timeout: 15_000 }
  )
  check('tab picks up the page title', true)

  await shell.locator('.dt-row', { hasText: '<main' }).first().waitFor({ timeout: 15_000 })
  check('DevTools shows the page DOM', true)

  await shell.waitForFunction(async () => (await window.reconix.network.getStats()).total >= 2, null, {
    timeout: 15_000
  })
  check('request capture saw the page and its stylesheet', true)

  // counts reach the UI through a throttled push, so wait for it rather than assume
  await shell.locator('.statusbar', { hasText: /Requests: [1-9]/ }).waitFor({ timeout: 15_000 })
  check('status bar shows the live request count', true)

  const rejected = await shell.evaluate(() => window.reconix.target.navigate('file:///etc/hosts'))
  check('rejects non-http navigation', rejected.ok === false)

  await shell.evaluate(() => window.reconix.tabs.create())
  const two = await shell.evaluate(() => window.reconix.tabs.getState())
  check('opens a second tab and switches to it', two.tabs.length === 2 && two.activeId === two.tabs[1].id)

  mkdirSync(outDir, { recursive: true })
  await shell.screenshot({ path: join(outDir, `smoke-${platform}${packaged ? '-packaged' : ''}.png`) })
} catch (error) {
  check('smoke test ran to completion', false, error.message)
} finally {
  await app?.close().catch(() => {})
  server.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
