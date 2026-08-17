// Auto-update wiring (electron-updater, GitHub provider). No-op when not
// packaged (dev runs don't hit the feed).
import { app } from 'electron'
import updaterPkg from 'electron-updater'
import { APP_ID } from './constants.js'
import { logs } from './log-store.js'
import { detectVariant } from './runtime.js'

const { autoUpdater } = updaterPkg

export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

type StatusListener = (s: UpdateStatus) => void

const listeners = new Set<StatusListener>()
let current: UpdateStatus = { phase: 'idle' }

export function onUpdateStatus(cb: StatusListener): () => void {
  listeners.add(cb)
  cb(current)
  return () => listeners.delete(cb)
}

function set(s: UpdateStatus): void {
  current = s
  for (const cb of listeners) cb(s)
}

export function updaterEnabled(): boolean {
  return app.isPackaged
}

export function initUpdater(): void {
  if (!updaterEnabled()) {
    logs.info('app', 'auto-update disabled (dev run)')
    return
  }
  try {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.forceDevUpdateConfig = false
    // Per-variant update channel (full.yml / slim.yml) so both variants can
    // share one GitHub release without clobbering each other's update feed.
    const variant = detectVariant()
    autoUpdater.channel = variant === 'full' ? 'full' : variant === 'slim' ? 'slim' : 'latest'
    autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      set({ phase: 'available', version: info.version })
      logs.info('app', `update available: ${info.version}`)
    })
    autoUpdater.on('update-not-available', () => set({ phase: 'not-available' }))
    autoUpdater.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => {
      set({ phase: 'downloaded', version: info.version })
      logs.info('app', `update downloaded: ${info.version}`)
    })
    autoUpdater.on('error', (err) => {
      set({ phase: 'error', message: err.message })
      logs.warn('app', `updater error: ${err.message}`)
    })
    autoUpdater.logger = null // keep console clean; our log-store covers it
    // @ts-expect-error - app-update.yml channel id uses appId
    autoUpdater.appId = APP_ID
  } catch (err) {
    logs.warn('app', `updater init failed: ${(err as Error).message}`)
  }
}

export async function checkForUpdates(): Promise<void> {
  if (!updaterEnabled()) return
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    set({ phase: 'error', message: (err as Error).message })
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    set({ phase: 'error', message: (err as Error).message })
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
