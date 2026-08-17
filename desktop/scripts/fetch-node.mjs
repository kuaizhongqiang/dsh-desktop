// Download official Node binary (Windows x64) into desktop/resources/node (Full variant).
// Usage: node scripts/fetch-node.mjs [--mirror <url>]
// Mirror semantics: replace the https://nodejs.org prefix with the mirror root,
// e.g. https://npmmirror.com/mirrors/node → /v22.22.1/node-v22.22.1-win-x64.zip
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.json' with { type: 'json' }

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const args = process.argv.slice(2)
const mirror = args.includes('--mirror') ? args[args.indexOf('--mirror') + 1] : null
const outDir = join(root, 'resources', 'node')

const base = mirror
  ? `${mirror}/v${config.nodeVersion}/${config.nodeDistBase}.zip`
  : config.nodeDistUrl
const shasums = mirror
  ? `${mirror}/v${config.nodeVersion}/SHASUMS256.txt`
  : config.nodeShasumsUrl
const zipName = base.split('/').pop()
const tmpZip = join(tmpdir(), zipName)
const nodeExe = join(outDir, config.nodeDistBase, 'node.exe')

function download(url, dest) {
  console.log(`[fetch-node] downloading ${url}`)
  return new Promise((resolveP, rejectP) => {
    if (process.platform === 'win32') {
      // curl.exe ships with Windows 10+; retries + resume are far more robust
      // than node:https against flaky TLS/proxies.
      const curl = spawn('curl.exe', ['-L', '--fail', '--retry', '6', '--retry-all-errors', '--retry-delay', '2', '-C', '-', '-o', dest, url], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
      })
      curl.once('exit', (code) => (code === 0 ? resolveP() : rejectP(new Error(`curl exit ${code}`))))
      curl.once('error', rejectP)
      return
    }
    get(url, (res) => {
      if (res.statusCode !== 200) {
        rejectP(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const ws = createWriteStream(dest)
      res.pipe(ws)
      ws.on('finish', () => ws.close(() => resolveP()))
      ws.on('error', rejectP)
    }).on('error', rejectP)
  })
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(nodeExe)) {
    await download(base, tmpZip)
    // verify sha256 against SHASUMS256.txt
    const sums = await fetchText(shasums)
    const expected = sums.split('\n').find((l) => l.includes(zipName))?.split(/\s+/)[0]
    if (!expected) throw new Error(`sha256 for ${zipName} not found in SHASUMS256.txt`)
    const actual = createHash('sha256').update(readFileSync(tmpZip)).digest('hex')
    if (actual !== expected) throw new Error(`sha256 mismatch for ${zipName}: expected ${expected}, got ${actual}`)
    console.log(`[fetch-node] sha256 ok: ${actual.slice(0, 16)}…`)
    // extract (Windows 10+ ships bsdtar which handles zip)
    execFileSync('tar', ['-xf', tmpZip, '-C', outDir], { stdio: 'inherit' })
    rmSync(tmpZip, { force: true })
  } else {
    console.log(`[fetch-node] node.exe already present: ${nodeExe}`)
  }
  const v = execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim()
  console.log(`[fetch-node] ok: ${v} at ${nodeExe}`)
}

function fetchText(url, redirects = 0) {
  return new Promise((resolveP, rejectP) => {
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        fetchText(new URL(res.headers.location, url).toString(), redirects + 1).then(resolveP, rejectP)
        return
      }
      if (res.statusCode !== 200) { rejectP(new Error(`HTTP ${res.statusCode} for ${url}`)); res.resume(); return }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolveP(data))
    }).on('error', rejectP)
  })
}

main().catch((e) => { console.error(`[fetch-node] FAILED: ${e.message}`); process.exit(1) })
