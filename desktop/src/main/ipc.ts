// IPC surface between main and the app:// renderers. Kept minimal: renderers
// only ever see the events/handlers listed here (§7.2).
import { app, dialog, ipcMain } from 'electron'
import type { DshServer } from './dsh-server.js'
import { checkEnv, type EnvStatus } from './env-check.js'
import { getSettings, saveSettings } from './settings.js'
import { logs } from './log-store.js'
import { checkForUpdates, downloadUpdate, installUpdate, updaterEnabled, onUpdateStatus } from './updater.js'
import { runBootstrap, cancelBootstrap, onBootstrapEvent } from './bootstrap.js'
import { openView, showBootstrapWindow, getBootstrapWindow, broadcastEvent } from './windows.js'
import { detectVariant } from './runtime.js'

export interface AppState {
  variant: string
  appVersion: string
  server: { status: string; port: number | null; url: string | null }
  settings: ReturnType<typeof getSettings>
  env: EnvStatus | null
  updateEnabled: boolean
}

export function registerIpc(server: DshServer, onQuit: () => void): void {
  ipcMain.handle('app:get-state', async (): Promise<AppState> => ({
    variant: detectVariant(),
    appVersion: app.getVersion(),
    server: { status: server.getStatus(), port: server.getPort(), url: server.getUrl() },
    settings: getSettings(),
    env: null,
    updateEnabled: updaterEnabled(),
  }))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: object) => {
    const next = saveSettings(patch as Parameters<typeof saveSettings>[0])
    broadcastEvent({ type: 'settings', settings: next })
    return next
  })
  ipcMain.handle('settings:choose-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  ipcMain.handle('server:restart', async () => {
    broadcastEvent({ type: 'server-status', status: 'starting' })
    const result = await server.restart()
    return result
  })

  ipcMain.handle('log:get', () => logs.getRecent(500))
  ipcMain.handle('log:clear', () => { logs.clear(); return true })
  ipcMain.handle('log:export', async () => {
    const r = await dialog.showSaveDialog({ defaultPath: `dsh-desktop-logs-${Date.now()}.log`, filters: [{ name: 'log', extensions: ['log', 'txt'] }] })
    if (r.canceled || !r.filePath) return null
    logs.exportTo(r.filePath)
    return r.filePath
  })

  ipcMain.handle('env:check', () => checkEnv())

  ipcMain.handle('bootstrap:run', async () => {
    const result = await runBootstrap()
    return result
  })
  ipcMain.handle('bootstrap:cancel', () => { cancelBootstrap(); return true })

  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', () => installUpdate())

  ipcMain.handle('window:open', (_e, view: string) => {
    if (view === 'bootstrap') showBootstrapWindow()
    else openView(view)
    return true
  })

  ipcMain.handle('app:quit', () => { onQuit(); return true })

  // Stream main-process events to renderers.
  server.on('status', (status, detail) => broadcastEvent({ type: 'server-status', status, detail }))
  server.on('ready', (info) => broadcastEvent({ type: 'server-ready', port: info.port, url: info.url }))
  server.on('crashed', (info) => broadcastEvent({ type: 'server-crashed', ...info }))
  logs.on('entry', (entry) => broadcastEvent({ type: 'log', entry }))
  onBootstrapEvent((ev) => broadcastEvent({ type: 'bootstrap', ev }))
  onUpdateStatus((status) => broadcastEvent({ type: 'update', status }))
}
