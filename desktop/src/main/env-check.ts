// Slim variant environment detection: system node (>= 22.19) and global dsh.
import { execFile } from 'node:child_process'
import { NODE_MIN, NODE_MIN_LABEL } from './constants.js'
import { logs } from './log-store.js'

export interface ToolStatus {
  present: boolean
  version: string | null
  ok: boolean
}

export interface EnvStatus {
  node: ToolStatus
  dsh: ToolStatus
  /** True when node present+ok AND dsh present. */
  ready: boolean
}

function parseVersion(v: string | null): [number, number, number] | null {
  if (!v) return null
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function atLeast(v: [number, number, number] | null, min: readonly [number, number, number]): boolean {
  if (!v) return false
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true
    if (v[i] < min[i]) return false
  }
  return true
}

function runVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, shell: process.platform === 'win32' }, (err, stdout) => {
      if (err) { resolve(null); return }
      resolve(String(stdout).trim().split('\n')[0] ?? null)
    })
  })
}

export async function checkEnv(): Promise<EnvStatus> {
  const nodeVersion = await runVersion('node', ['--version'])
  const dshVersion = await runVersion('dsh', ['--version'])
  const node = {
    present: nodeVersion !== null,
    version: nodeVersion,
    ok: atLeast(parseVersion(nodeVersion), NODE_MIN),
  }
  const dsh = {
    present: dshVersion !== null,
    version: dshVersion,
    ok: dshVersion !== null,
  }
  const status: EnvStatus = { node, dsh, ready: node.ok && dsh.ok }
  logs.info('bootstrap', `env check: node=${node.version ?? 'missing'}${node.ok ? '' : ` (<${NODE_MIN_LABEL})`}; dsh=${dsh.version ?? 'missing'}`)
  return status
}
