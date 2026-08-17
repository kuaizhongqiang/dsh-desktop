// Resolve the Node runtime and dsh entry point per build variant (D5/D6).
//   full: bundled official node.exe + bundled dsh npm-locked package
//   slim: system node + global `dsh` command (first-run bootstrap installs them)
//   dev : system node + local resources/dev-dsh (npm run prepare:dsh)
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_DIST_BASE } from './constants.js'

export type Variant = 'full' | 'slim' | 'dev'

export interface RuntimeInfo {
  variant: Variant
  /** How to launch dsh: run `node <dshPath>` or run the `dsh` command directly. */
  dsh: { mode: 'path' | 'command'; path?: string; command?: string }
  /** Node executable to run dsh with (mode 'path' only). */
  nodePath: string | null
}

function readVariantFile(file: string): Variant | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { variant?: string }
    if (v.variant === 'full' || v.variant === 'slim') return v.variant
  } catch {
    // ignore
  }
  return null
}

export function detectVariant(): Variant {
  if (app.isPackaged) {
    const fromResources = readVariantFile(join(process.resourcesPath, 'variant.json'))
    if (fromResources) return fromResources
  }
  return 'dev'
}

export function resolveRuntime(): RuntimeInfo {
  const variant = detectVariant()
  if (variant === 'full') {
    const nodePath = join(process.resourcesPath, 'node', NODE_DIST_BASE, 'node.exe')
    const dshPath = join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    return {
      variant,
      nodePath: existsSync(nodePath) ? nodePath : null,
      dsh: { mode: 'path', path: existsSync(dshPath) ? dshPath : undefined },
    }
  }
  if (variant === 'slim') {
    // Global `dsh` command; node resolved from PATH at spawn time.
    return { variant, nodePath: null, dsh: { mode: 'command', command: 'dsh' } }
  }
  // dev: system node + local dev install (desktop/resources/dev-dsh)
  const devRoot = join(app.getAppPath(), 'resources', 'dev-dsh')
  const dshPath = join(devRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return {
    variant,
    nodePath: 'node',
    dsh: { mode: 'path', path: existsSync(dshPath) ? dshPath : undefined },
  }
}
