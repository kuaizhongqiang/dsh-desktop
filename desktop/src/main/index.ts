// dsh-desktop main process entry: single instance → settings → tray/updater →
// (slim) environment bootstrap → dsh server → main window.
import { app, protocol } from 'electron'
import { appendFileSync } from 'node:fs'
import { createTray } from './tray.js'
import { DshServer } from './dsh-server.js'
import { getSettings, loadSettings, saveSettings } from './settings.js'
import { logs } from './log-store.js'
import { registerIpc } from './ipc.js'
import { checkEnv } from './env-check.js'
import { initUpdater, checkForUpdates } from './updater.js'
import { onBootstrapEvent } from './bootstrap.js'
import {
  createMainWindow, showStartPage, showCrashPage, loadDshUrl,
  getMainWindow, openView, initWindows, showBootstrapWindow,
} from './windows.js'
import { detectVariant, type Variant } from './runtime.js'
import { APP_ID } from './constants.js'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let variant: Variant = 'dev'
  const server = new DshServer()
  let reallyQuit = false
  let mainReady = false

  app.setAppUserModelId(APP_ID)

  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.on('window-all-closed', () => {
    // Merely having this listener keeps the app alive when every window closes;
    // tray mode (closeToTray) is the default, so no quit here.
    if (!getSettings().closeToTray || reallyQuit) app.quit()
  })

  app.on('before-quit', () => {
    reallyQuit = true
    void server.stop()
  })

  app.whenReady().then(() => {
    loadSettings()
    initWindows()
    registerIpc(server, () => app.quit())
    logs.info('app', `dsh-desktop starting (variant=${detectVariant()}, version=${app.getVersion()})`)
    initUpdater()
    variant = detectVariant()
    createTray(server, {
      showMain: () => getMainWindow()?.show(),
      toggleMain: () => {
        const win = getMainWindow()
        if (win && win.isVisible()) win.hide()
        else getMainWindow()?.show()
      },
      restartServer: () => { void server.restart() },
      openLogs: () => openView('log'),
      openSettings: () => openView('settings'),
      checkUpdates: () => void checkForUpdates(),
      quit: () => app.quit(),
    })

    void boot()
  })

  async function boot(): Promise<void> {
    const smoke = process.argv.includes('--smoke')
    const smokeFile = process.env.DSH_SMOKE_FILE
    const smokeOut = (line: string): void => {
      console.log(line)
      if (smokeFile) appendFileSync(smokeFile, `${line}\n`, 'utf8')
    }
    try {
      if (smoke) smokeOut('SMOKE boot-start')
      if (variant === 'slim') {
        const env = await checkEnv()
        if (!env.ready) {
          const ok = await runBootstrapGate()
          if (!ok) {
            if (smoke) { smokeOut('SMOKE_FAIL bootstrap-cancelled'); app.exit(1) }
            else app.quit()
            return
          }
          saveSettings({ bootstrapDone: true })
        }
      }

      const { port, url } = await server.start()
      mainReady = true

      if (smoke) {
        smokeOut(`SMOKE_OK port=${port} url=${url}`)
        await server.stop()
        app.exit(0)
        return
      }

      const win = createMainWindow()
      showStartPage(win)
      await loadDshUrl(win, url)
      void checkForUpdates()
    } catch (err) {
      const message = (err as Error).message
      logs.error('app', `boot failed: ${message}`)
      if (smoke) { smokeOut(`SMOKE_FAIL ${message}`); app.exit(1); return }
      const win = getMainWindow() ?? createMainWindow()
      showCrashPage(win, message)
    }
  }

  /** Show the Slim bootstrap window and wait for a result. */
  function runBootstrapGate(): Promise<boolean> {
    const bwin = showBootstrapWindow()
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        off()
        if (!bwin.isDestroyed()) bwin.close()
        resolve(ok)
      }
      const off = onBootstrapEvent((ev) => {
        if (ev.type === 'done') finish(ev.ok)
      })
      bwin.once('closed', () => finish(false))
    })
  }

  server.on('crashed', () => {
    if (mainReady) {
      const win = getMainWindow()
      if (win) showCrashPage(win, 'dsh server 异常退出')
    }
  })
}
