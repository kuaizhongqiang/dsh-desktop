// dsh server subprocess lifecycle: port selection (pre-allocated, no --port 0
// blind spot per re-review), spawn, health-probe readiness, health monitoring,
// graceful stop with Windows process-tree cleanup.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import {
  GRACEFUL_STOP_MS, HEALTH_FAIL_LIMIT, HEALTH_INTERVAL_MS, PROBE_INTERVAL_MS, READY_TIMEOUT_MS,
} from './constants.js'
import { getSettings } from './settings.js'
import { logs } from './log-store.js'
import type { RuntimeInfo } from './runtime.js'

export type ServerStatus = 'stopped' | 'starting' | 'ready' | 'crashed' | 'stopping'

export interface ServerEvents {
  ready: (info: { port: number; url: string }) => void
  status: (status: ServerStatus, detail?: string) => void
  crashed: (info: { code: number | null; signal: string | null; reason: string }) => void
  logline: (line: string) => void
}

export class DshServer extends EventEmitter {
  private child: ChildProcess | null = null
  private status: ServerStatus = 'stopped'
  private port: number | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private healthFails = 0
  private stopping = false
  private lastStderrTail = ''

  getStatus(): ServerStatus { return this.status }
  getPort(): number | null { return this.port }
  getUrl(): string | null { return this.port === null ? null : `http://127.0.0.1:${this.port}` }

  private setStatus(s: ServerStatus, detail?: string): void {
    this.status = s
    this.emit('status', s, detail)
  }

  private portInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port })
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => resolve(false))
      setTimeout(() => { sock.destroy(); resolve(false) }, 800).unref()
    })
  }

  private preAllocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv: Server = createServer()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address()
        const port = typeof address === 'object' && address ? address.port : 0
        srv.close(() => resolve(port))
      })
    })
  }

  private async pickPort(preferred: number): Promise<number> {
    if (preferred > 0 && !(await this.portInUse(preferred))) return preferred
    logs.warn('app', `port ${preferred} in use, pre-allocating a free port`)
    return this.preAllocatePort()
  }

  private async probeHealth(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      return res.status === 200
    } catch {
      return false
    }
  }

  private async waitReady(port: number): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) return false
      if (await this.probeHealth(port)) return true
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
    }
    return false
  }

  private startHealthMonitor(port: number): void {
    this.healthTimer = setInterval(async () => {
      if (this.status !== 'ready') return
      const ok = await this.probeHealth(port)
      if (ok) { this.healthFails = 0; return }
      this.healthFails += 1
      logs.warn('app', `health probe failed ${this.healthFails}/${HEALTH_FAIL_LIMIT}`)
      if (this.healthFails >= HEALTH_FAIL_LIMIT) {
        this.emit('crashed', { code: null, signal: null, reason: 'health probe failed repeatedly' })
        void this.killTree()
      }
    }, HEALTH_INTERVAL_MS)
    this.healthTimer.unref()
  }

  private killTree(): Promise<void> {
    const pid = this.child?.pid
    if (pid === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      // Windows: terminate the whole tree (dsh may spawn helpers)
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      killer.once('exit', () => resolve())
      killer.once('error', () => resolve())
      setTimeout(resolve, 2000).unref()
    })
  }

  private async spawnServer(): Promise<number> {
    const settings = getSettings()
    const port = await this.pickPort(settings.port)
    const { resolveRuntime } = await import('./runtime.js')
    const runtime: RuntimeInfo = resolveRuntime()
    this.port = port

    const args = ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port)]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(settings.dataDir ? { DSH_HOME: settings.dataDir } : {}),
    }

    let child: ChildProcess
    if (runtime.dsh.mode === 'path' && runtime.nodePath) {
      if (!runtime.dsh.path) throw new Error('dsh entry not found (run npm run prepare:dsh / Full variant resources)')
      child = spawn(runtime.nodePath, [runtime.dsh.path, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (runtime.dsh.mode === 'command') {
      child = spawn(runtime.dsh.command!, args, { env, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      throw new Error(`unsupported runtime: ${JSON.stringify(runtime.dsh)}`)
    }
    this.child = child

    const tag = (buf: Buffer): void => {
      const text = buf.toString('utf8')
      logs.push('info', 'server', text)
      this.emit('logline', text)
    }
    child.stdout?.on('data', tag)
    child.stderr?.on('data', (buf) => {
      const text = buf.toString('utf8')
      this.lastStderrTail = (this.lastStderrTail + text).slice(-2000)
      logs.push('warn', 'server', text)
      this.emit('logline', text)
    })
    child.once('exit', (code, signal) => {
      logs.info('app', `dsh server exited code=${code} signal=${String(signal)}`)
      if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null }
      if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }
      if (this.stopping) return
      this.setStatus('crashed')
      this.emit('crashed', {
        code, signal,
        reason: this.lastStderrTail.trim().split('\n').slice(-3).join(' | ') || 'process exited',
      })
    })
    return port
  }

  async start(): Promise<{ port: number; url: string }> {
    await this.stop()
    this.stopping = false
    this.setStatus('starting')
    const port = await this.spawnServer()

    const ready = await this.waitReady(port)
    if (!ready) {
      const stderrHint = this.lastStderrTail.includes('EADDRINUSE') ? ' (port conflict)' : ''
      const reason = `server did not become ready within ${READY_TIMEOUT_MS}ms${stderrHint}: ${this.lastStderrTail.trim().split('\n').slice(-2).join(' | ')}`
      logs.error('app', reason)
      await this.killTree()
      this.setStatus('crashed')
      this.emit('crashed', { code: null, signal: null, reason })
      throw new Error(reason)
    }

    this.setStatus('ready', `http://127.0.0.1:${port}`)
    this.startHealthMonitor(port)
    this.emit('ready', { port, url: `http://127.0.0.1:${port}` })
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async restart(): Promise<{ port: number; url: string } | null> {
    try {
      return await this.start()
    } catch (err) {
      logs.error('app', `restart failed: ${(err as Error).message}`)
      return null
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null
      this.setStatus('stopped')
      return
    }
    this.setStatus('stopping')
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const done = await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_STOP_MS)),
    ])
    if (done === undefined && child.exitCode === null) {
      logs.warn('app', 'graceful stop timed out; force-killing process tree')
      await this.killTree()
      await new Promise((r) => setTimeout(r, 500))
    }
    this.child = null
    this.setStatus('stopped')
  }

  /** Where the bundled/shim entry lives, for diagnostics. */
  static describe(): string { return join(process.resourcesPath, 'dsh') }
}
