// Shared constants for dsh-desktop. Single source of truth for product-level
// values; runtime-relevant versions mirror desktop/config.json (used by scripts).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_NAME = 'dsh-desktop'
export const APP_ID = 'com.dshdesktop.app'
export const DEFAULT_PORT = 3080

/** Minimum system Node version accepted by dsh (dsh engines: ^22.19.0 || >=24.0.0). */
export const NODE_MIN = [22, 19, 0] as const
export const NODE_MIN_LABEL = '22.19.0'

export const READY_TIMEOUT_MS = 30_000
export const PROBE_INTERVAL_MS = 300
export const HEALTH_INTERVAL_MS = 10_000
export const HEALTH_FAIL_LIMIT = 3
export const GRACEFUL_STOP_MS = 5_000
export const LOG_RING_SIZE = 2_000
export const LOG_EXPORT_HEAD = 20

const here = dirname(fileURLToPath(import.meta.url))
// desktop/out/main/constants.js -> desktop/
const desktopRoot = join(here, '..', '..')

export interface RuntimeConfigJson {
  dshVersion: string
  nodeVersion: string
  nodeDistBase: string
  nodeDistUrl: string
  nodeShasumsUrl: string
  nodeMirrorPrefix: string
}

export function loadRuntimeConfig(): RuntimeConfigJson {
  return JSON.parse(readFileSync(join(desktopRoot, 'config.json'), 'utf8')) as RuntimeConfigJson
}

export const RUNTIME_CONFIG = loadRuntimeConfig()
export const DSH_VERSION = RUNTIME_CONFIG.dshVersion
export const NODE_VERSION = RUNTIME_CONFIG.nodeVersion
export const NODE_DIST_BASE = RUNTIME_CONFIG.nodeDistBase
