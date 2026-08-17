// Slim bootstrap: guided/automatic install of missing Node and global dsh.
// Every network/write step requires explicit user confirmation (sent from the
// bootstrap renderer via opts.autoDownload + per-step confirm) — §7.2.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { DSH_VERSION, NODE_VERSION, NODE_DIST_BASE, NODE_MIN_LABEL } from './constants.js'
import { checkEnv, type EnvStatus } from './env-check.js'
import { logs } from './log-store.js'
import { getSettings } from './settings.js'

export interface BootstrapStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
}

export type BootstrapEvent =
  | { type: 'step'; step: BootstrapStep }
  | { type: 'progress'; id: string; percent: number }
  | { type: 'done'; ok: boolean; status: EnvStatus }

type StepListener = (ev: BootstrapEvent) => void

const listeners = new Set<StepListener>()

export function onBootstrapEvent(cb: StepListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(ev: BootstrapEvent): void {
  for (const cb of listeners) cb(ev)
}

let running = false
let cancelled = false

export function cancelBootstrap(): void { cancelled = true }

function download(url: string, dest: string, stepId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // curl.exe (Windows 10+) is far more robust than node:https against
      // flaky TLS/proxies (retries + resume); progress is opaque, so report
      // indeterminate progress instead of percentages.
      const curl = spawn('curl.exe', ['-L', '--fail', '--retry', '6', '--retry-all-errors', '--retry-delay', '2', '-C', '-', '-o', dest, url], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
      })
      curl.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`curl exit ${code}`))))
      curl.once('error', reject)
      return
    }
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const total = Number(res.headers['content-length'] ?? 0)
      let got = 0
      const ws = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (total > 0) emit({ type: 'progress', id: stepId, percent: Math.min(99, Math.round((got / total) * 100)) })
      })
      res.pipe(ws)
      ws.on('finish', () => ws.close(() => resolve()))
      ws.on('error', reject)
    }).on('error', reject)
  })
}

async function fetchText(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location && redirects < 5) {
        res.resume()
        void fetchText(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject)
        return
      }
      if ((res.statusCode ?? 0) !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); res.resume(); return }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

function mirrorize(url: string, mirror: string): string {
  if (!mirror) return url
  // mirror layout: {mirror}/v<ver>/<dist>.zip (npmmirror / huawei), no /dist/ segment
  const ver = url.match(/\/dist\/v([\d.]+)\//)?.[1]
  if (ver) return url.replace(`/dist/v${ver}/`, `/v${ver}/`).replace(/^https:\/\/nodejs\.org/, mirror)
  return url.replace('https://nodejs.org', mirror)
}

async function downloadNode(mirror: string, stepId: string): Promise<string> {
  const destDir = join(app.getPath('userData'), 'node-dist')
  mkdirSync(destDir, { recursive: true })
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`
  const zipUrl = mirrorize(`${base}/${NODE_DIST_BASE}.zip`, mirror)
  const shasUrl = mirrorize(`${base}/SHASUMS256.txt`, mirror)
  const zipName = zipUrl.split('/').pop()!
  const zipPath = join(tmpdir(), `dsh-node-${zipName}`)

  emit({ type: 'step', step: { id: stepId, label: `下载 Node.js v${NODE_VERSION}`, status: 'running' } })
  await download(zipUrl, zipPath, stepId)
  const sums = await fetchText(shasUrl)
  const expected = sums.split('\n').find((l) => l.includes(zipName))?.split(/\s+/)[0]
  if (!expected) throw new Error(`SHA256 for ${zipName} not in SHASUMS256.txt`)
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${zipName}`)

  emit({ type: 'step', step: { id: stepId, label: `解压 Node.js v${NODE_VERSION}`, status: 'running', detail: '校验通过，正在解压' } })
  const nodeExe = join(destDir, NODE_DIST_BASE, 'node.exe')
  if (!existsSync(nodeExe)) {
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true })
      tar.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
      tar.once('error', reject)
    })
  }
  return nodeExe
}

async function installDshGlobal(mirror: string, stepId: string): Promise<void> {
  emit({ type: 'step', step: { id: stepId, label: `安装 dsh（全局）v${DSH_VERSION}`, status: 'running', detail: 'npm install -g @deepseek-ai/dsh@' + DSH_VERSION } })
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (mirror) env.npm_config_registry = mirror
  await new Promise<void>((resolve, reject) => {
    const p = spawn('npm', ['install', '-g', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${DSH_VERSION}`], {
      env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    p.stdout?.on('data', (b) => logs.info('bootstrap', String(b)))
    p.stderr?.on('data', (b) => logs.warn('bootstrap', String(b)))
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install -g exit ${code}`))))
    p.once('error', reject)
  })
}

export async function runBootstrap(): Promise<{ ok: boolean; status: EnvStatus }> {
  if (running) return { ok: false, status: await checkEnv() }
  running = true
  cancelled = false
  const settings = getSettings()
  try {
    let status = await checkEnv()
    if (status.ready) {
      emit({ type: 'done', ok: true, status })
      return { ok: true, status }
    }
    // Node
    if (!status.node.ok) {
      if (!settings.autoDownload) {
        emit({ type: 'step', step: { id: 'node', label: `需要 Node.js ≥ ${NODE_MIN_LABEL}`, status: 'error', detail: '已关闭自动下载，请手动安装后重试' } })
        emit({ type: 'done', ok: false, status })
        return { ok: false, status }
      }
      try {
        const nodeExe = await downloadNode(settings.mirrorUrl, 'node')
        // make the downloaded node usable as `node` for this session and persist
        emit({ type: 'step', step: { id: 'node', label: `Node.js v${NODE_VERSION}`, status: 'done', detail: nodeExe } })
      } catch (err) {
        emit({ type: 'step', step: { id: 'node', label: 'Node.js 下载失败', status: 'error', detail: (err as Error).message } })
        logs.error('bootstrap', `node download failed: ${(err as Error).message}`)
        emit({ type: 'done', ok: false, status })
        return { ok: false, status }
      }
    } else {
      emit({ type: 'step', step: { id: 'node', label: 'Node.js', status: 'done', detail: status.node.version! } })
    }
    if (cancelled) { emit({ type: 'done', ok: false, status: await checkEnv() }); return { ok: false, status: await checkEnv() } }
    // dsh
    if (!status.dsh.present) {
      try {
        await installDshGlobal(settings.mirrorUrl, 'dsh')
        emit({ type: 'step', step: { id: 'dsh', label: `dsh v${DSH_VERSION}`, status: 'done', detail: '全局安装完成' } })
      } catch (err) {
        emit({ type: 'step', step: { id: 'dsh', label: 'dsh 安装失败', status: 'error', detail: (err as Error).message } })
        logs.error('bootstrap', `dsh install failed: ${(err as Error).message}`)
        emit({ type: 'done', ok: false, status: await checkEnv() })
        return { ok: false, status: await checkEnv() }
      }
    } else {
      emit({ type: 'step', step: { id: 'dsh', label: 'dsh', status: 'done', detail: status.dsh.version! } })
    }
    status = await checkEnv()
    emit({ type: 'done', ok: status.ready, status })
    return { ok: status.ready, status }
  } finally {
    running = false
  }
}
