#!/usr/bin/env node
/**
 * Downloads the OpenCode standalone binary for the current platform into
 * `resources/opencode-<platform>/` so electron-builder can ship it as an
 * extraResource (see electron-builder.yml).
 *
 * Why bundle it: the packaged app cannot rely on `opencode` being installed on
 * the user's machine (or on npm's global bin dir being on PATH). Shipping the
 * release binary next to the app makes `opencode serve` spawnable from
 * process.resourcesPath (copilot.ts's resolveOpenCodeBinary()).
 *
 * Layout produced (consumed by electron-builder.yml `extraResources`):
 *   resources/opencode-linux/opencode
 *   resources/opencode-mac/opencode
 *   resources/opencode-win/opencode.exe   (not produced — see below)
 *
 * Windows: upstream does not publish Windows binaries for this repository
 * (only .deb/.rpm/tar.gz), so this script warns and exits 0 there. The app
 * still runs on Windows using a system-installed `opencode`.
 *
 * Node built-ins only (fetch + fs + child_process); extraction shells out to
 * the system `tar`, which is present on every Linux/macOS CI runner.
 *
 * Usage: node scripts/download-opencode.mjs
 * Env:   GITHUB_TOKEN   optional, raises the GitHub API rate limit
 *        OPENCODE_RELEASE_REPO  optional override, default "opencode-ai/opencode"
 *        OPENCODE_VERSION       optional tag (e.g. v0.0.55); default = latest
 */

import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_REPO = process.env.OPENCODE_RELEASE_REPO || 'opencode-ai/opencode'
const RELEASE_VERSION = process.env.OPENCODE_VERSION || 'latest'

/** POSIX extraction + binary name; null means "no published binary". */
const PLATFORM_TARGETS = {
  linux: {
    key: 'linux',
    binary: 'opencode',
    assets: {
      x64: 'opencode-linux-x86_64.tar.gz',
      arm64: 'opencode-linux-arm64.tar.gz',
    },
  },
  darwin: {
    key: 'mac',
    binary: 'opencode',
    assets: {
      x64: 'opencode-mac-x86_64.tar.gz',
      arm64: 'opencode-mac-arm64.tar.gz',
    },
  },
  win32: null,
}

function log(msg) {
  console.log(`[opencode] ${msg}`)
}

function fail(msg) {
  console.error(`[opencode] ERROR: ${msg}`)
  process.exit(1)
}

function releaseApiUrl() {
  return RELEASE_VERSION === 'latest'
    ? `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`
    : `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${RELEASE_VERSION}`
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'reconix-build',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return headers
}

/** Resolves the release asset for this platform, or explains why there is none. */
function pickAsset(release, target, arch) {
  const wanted =
    target.assets[arch] ||
    target.assets.x64

  const asset = (release.assets || []).find((a) => a.name === wanted)
  if (!asset) {
    const available = (release.assets || []).map((a) => a.name).join(', ')
    fail(
      `release ${release.tag_name} has no asset "${wanted}" for ${process.platform}/${arch}.\n` +
        `           available assets: ${available || '(none)'}`
    )
  }
  return asset
}

async function download(url, destPath) {
  const res = await fetch(url, { headers: githubHeaders(), redirect: 'follow' })
  if (!res.ok || !res.body) {
    fail(`download failed (${res.status} ${res.statusText}) for ${url}`)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
}

async function extractTarGz(archive, destDir) {
  // Extract the whole tarball, then find the `opencode` binary wherever it
  // landed inside (GitHub release tarballs often nest it under a
  // platform-specific subdirectory like opencode-x86_64-unknown-linux-gnu/).
  await execFileAsync('tar', ['-xzf', archive, '-C', destDir], {
    maxBuffer: 16 * 1024 * 1024,
  })

  // Recursively find a file named 'opencode' or 'opencode.exe' anywhere in destDir.
  async function findBinary(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await findBinary(full)
        if (found) return found
      } else if (entry.name === 'opencode' || entry.name === 'opencode.exe') {
        return full
      }
    }
    return null
  }

  const found = await findBinary(destDir)
  if (!found) {
    const listing = (await readdir(destDir, { withFileTypes: true }))
      .map((e) => `${e.isDirectory() ? 'dir' : 'file '} ${e.name}`)
      .join('\n  ')
    fail(`no 'opencode' binary found inside the extracted tarball.\n` +
      `           contents of ${destDir}:\n  ${listing}`)
  }

  const destBinary = join(destDir, 'opencode')
  if (found !== destBinary) {
    await execFileAsync('mv', [found, destBinary], { windowsHide: true })
  }

  return destBinary
}

async function main() {
  const arch = process.arch
  const target = PLATFORM_TARGETS[process.platform]

  if (!target) {
    log(`no standalone OpenCode binary is published for ${process.platform}/${arch}.`)
    log('Windows is expected to use a system-installed opencode; nothing to bundle.')
    return
  }

  log(`fetching ${RELEASE_VERSION} metadata from ${RELEASE_REPO} ...`)
  const releaseRes = await fetch(releaseApiUrl(), { headers: githubHeaders(), redirect: 'follow' })
  if (!releaseRes.ok) {
    fail(`GitHub API returned ${releaseRes.status} ${releaseRes.statusText} for ${releaseApiUrl()}`)
  }
  const release = await releaseRes.json()
  const asset = pickAsset(release, target, arch)

  const destDir = join(REPO_ROOT, 'resources', `opencode-${target.key}`)
  await mkdir(destDir, { recursive: true })

  const tmpDir = await mkdtemp(join(tmpdir(), 'reconix-opencode-'))
  const archivePath = join(tmpDir, asset.name)

  try {
    log(`downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MiB) ...`)
    await download(asset.browser_download_url, archivePath)

    log(`extracting into ${destDir} ...`)
    await extractTarGz(archivePath, destDir)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }

  const destBinary = join(destDir, target.binary)
  const info = await stat(destBinary).catch(() => null)
  if (!info || info.size === 0) {
    fail(`extraction produced no binary at ${destBinary}`)
  }

  // tar preserves the mode, but be explicit: electron-builder copies the mode
  // through, and a non-executable extraResource is the classic bundling bug.
  await chmod(destBinary, 0o755)

  await writeFile(
    join(destDir, 'VERSION'),
    `${release.tag_name}\n${asset.name}\n${asset.browser_download_url}\n`,
    'utf8'
  )

  log(`ok: ${destBinary} (${release.tag_name}, ${(info.size / 1024 / 1024).toFixed(1)} MiB)`)
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err))
})
