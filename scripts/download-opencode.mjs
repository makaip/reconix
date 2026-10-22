// Downloads the OpenCode standalone binary from GitHub releases and extracts it
// into resources/opencode-<platform>/ so electron-builder can bundle it.
//
// Usage: node scripts/download-opencode.mjs
//
// Skips Windows (no standalone Windows binary is published by opencode-ai —
// Windows users install via npm instead, handled by the pre-flight check in
// copilot.ts).
//
// Runs on every CI job (macOS + Linux runners) before packaging, and can be
// run locally to verify the download/extraction path.

import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

const execFileAsync = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr ?? err.message))
      else resolve({ stdout, stderr })
    })
  })

const GITHUB_REPO = 'opencode-ai/opencode'
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
const RESOURCES_DIR = join(process.cwd(), 'resources')

function platformAssetName() {
  const plat = process.platform
  const arch = process.arch

  if (plat === 'linux') {
    return { platform: 'linux', asset: 'opencode-linux-x86_64.tar.gz' }
  }
  if (plat === 'darwin') {
    return arch === 'arm64'
      ? { platform: 'mac', asset: 'opencode-mac-arm64.tar.gz' }
      : { platform: 'mac', asset: 'opencode-mac-x86_64.tar.gz' }
  }
  // Windows: no standalone binary published. Pre-flight check handles it.
  return null
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
  }
  const file = createWriteStream(dest)
  await pipeline(res.body, file)
}

async function main() {
  const info = platformAssetName()
  if (!info) {
    console.log(
      `[download-opencode] platform ${process.platform} has no standalone OpenCode binary — skipping (pre-flight check handles PATH fallback)`
    )
    process.exit(0)
  }

  const { platform, asset } = info
  const destDir = join(RESOURCES_DIR, `opencode-${platform}`)

  console.log(`[download-opencode] fetching ${asset} from ${RELEASES_API}`)

  // Resolve the latest release's download URL via the GitHub API (no auth
  // needed for public releases; rate limits are generous for read-only).
  let release
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`)
    release = await res.json()
  } catch (err) {
    console.error(`[download-opencode] failed to query releases API: ${err.message}`)
    process.exit(1)
  }

  const assetUrl = release.assets.find((a) => a.name === asset)?.browser_download_url
  if (!assetUrl) {
    console.error(`[download-opencode] asset "${asset}" not found in latest release`)
    process.exit(1)
  }

  await mkdir(destDir, { recursive: true })
  const tarball = join(destDir, asset)
  await download(assetUrl, tarball)

  // Extract (system tar available on all CI runners).
  await execFileAsync('tar', ['-xzf', tarball, '-C', destDir], { windowsHide: true })

  // The tar may contain a top-level dir (e.g. opencode-x86_64-unknown-linux-gnu/).
  // Flatten so the binary ends up at destDir/opencode.
  const entries = (await execFileAsync('ls', [destDir], { windowsHide: true })).stdout
    .trim()
    .split('\n')
  const subdirs = entries.filter((e) => e.startsWith(`opencode-${platform}`) || e.startsWith('opencode-'))
  if (subdirs.length === 1) {
    const subdir = join(destDir, subdirs[0])
    const binContents = (await execFileAsync('ls', [subdir], { windowsHide: true })).stdout.trim().split('\n')
    // Move the `opencode` binary up one level.
    const binName = binContents.find((f) => f === 'opencode' || f === 'opencode.exe')
    if (binName) {
      await execFileAsync('mv', [join(subdir, binName), join(destDir, 'opencode')], { windowsHide: true })
      // Remove the now-empty wrapper dir.
      await execFileAsync('rm', ['-rf', subdir], { windowsHide: true })
    }
  }

  // Make executable on POSIX.
  if (process.platform !== 'win32') {
    await execFileAsync('chmod', ['+x', join(destDir, 'opencode')], { windowsHide: true })
  }

  // Clean up the tarball.
  try {
    await execFileAsync('rm', ['-f', tarball], { windowsHide: true })
  } catch {
    /* ignore */
  }

  const finalBin = join(destDir, 'opencode')
  console.log(`[download-opencode] binary ready at ${finalBin}`)
}

main().catch((err) => {
  console.error(`[download-opencode] FATAL: ${err.message}`)
  process.exit(1)
})
