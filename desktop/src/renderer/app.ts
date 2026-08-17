// Renderer app for ui.html views: bootstrap / log / settings / crash.
// Talks to main only through window.dshApi (contextBridge).

interface LogEntry { id: number; ts: number; level: 'info' | 'warn' | 'error'; source: string; text: string }
interface EnvStatus { node: { present: boolean; version: string | null; ok: boolean }; dsh: { present: boolean; version: string | null; ok: boolean }; ready: boolean }
interface Settings { port: number; autoLaunch: boolean; closeToTray: boolean; dataDir: string; mirrorUrl: string; autoDownload: boolean; bootstrapDone: boolean }

interface DshApi {
  getState(): Promise<unknown>
  onEvent(cb: (ev: unknown) => void): () => void
  getSettings(): Promise<Settings>
  setSettings(p: Partial<Settings>): Promise<Settings>
  chooseDirectory(): Promise<string | null>
  restartServer(): Promise<unknown>
  getLogs(): Promise<LogEntry[]>
  clearLogs(): Promise<boolean>
  exportLogs(): Promise<string | null>
  checkEnv(): Promise<EnvStatus>
  runBootstrap(): Promise<{ ok: boolean; status: EnvStatus }>
  cancelBootstrap(): Promise<boolean>
  checkUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  openView(v: string): Promise<boolean>
  quitApp(): Promise<boolean>
}

declare global { interface Window { dshApi: DshApi } }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'bootstrap'
let logsCache: LogEntry[] = []
let lastUpdatePhase = 'idle'
let updateVersion = ''

function show(viewName: string): void {
  for (const el of document.querySelectorAll<HTMLElement>('.view')) el.hidden = true
  const target = $(`view-${viewName}`)
  if (target) target.hidden = false
}

function logLine(entry: LogEntry): string {
  const t = new Date(entry.ts).toLocaleTimeString()
  return `[${t}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.text}`
}

// ── log view ──
function initLogView(): void {
  const out = $<HTMLPreElement>('log-output')
  const autoscroll = $<HTMLInputElement>('log-autoscroll')
  const renderAll = (): void => {
    out.textContent = logsCache.map(logLine).join('\n')
    if (autoscroll.checked) out.scrollTop = out.scrollHeight
  }
  void window.dshApi.getLogs().then((entries) => { logsCache = entries; renderAll() })
  $('btn-log-clear').addEventListener('click', () => { void window.dshApi.clearLogs().then(() => { logsCache = []; renderAll() }) })
  $('btn-log-export').addEventListener('click', async () => {
    const p = await window.dshApi.exportLogs()
    if (p) alert(`日志已导出：${p}`)
  })
  window.dshApi.onEvent((ev) => {
    const e = ev as { type: string; entry?: LogEntry }
    if (e.type === 'log' && e.entry) { logsCache.push(e.entry); renderAll() }
  })
}

// ── settings view ──
function initSettingsView(): void {
  const form = $<HTMLFormElement>('settings-form')
  void window.dshApi.getSettings().then((s) => {
    $<HTMLInputElement>('set-port').value = String(s.port)
    $<HTMLInputElement>('set-close-tray').checked = s.closeToTray
    $<HTMLInputElement>('set-autolaunch').checked = s.autoLaunch
    $<HTMLInputElement>('set-datadir').value = s.dataDir
    $<HTMLInputElement>('set-mirror').value = s.mirrorUrl
    $<HTMLInputElement>('set-autodownload').checked = s.autoDownload
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const patch: Partial<Settings> = {
      port: Number($<HTMLInputElement>('set-port').value) || 0,
      closeToTray: $<HTMLInputElement>('set-close-tray').checked,
      autoLaunch: $<HTMLInputElement>('set-autolaunch').checked,
      dataDir: $<HTMLInputElement>('set-datadir').value.trim(),
      mirrorUrl: $<HTMLInputElement>('set-mirror').value.trim(),
      autoDownload: $<HTMLInputElement>('set-autodownload').checked,
    }
    await window.dshApi.setSettings(patch)
    const saved = $('settings-saved')
    saved.hidden = false
    setTimeout(() => { saved.hidden = true }, 1500)
  })
  $('btn-browse').addEventListener('click', async () => {
    const dir = await window.dshApi.chooseDirectory()
    if (dir) $<HTMLInputElement>('set-datadir').value = dir
  })
  $('btn-update-check').addEventListener('click', () => void window.dshApi.checkUpdates())
  $('btn-update-download').addEventListener('click', () => void window.dshApi.downloadUpdate())
  $('btn-update-install').addEventListener('click', () => void window.dshApi.installUpdate())
  renderUpdateStatus()
}

function renderUpdateStatus(): void {
  const el = $('update-status')
  const dl = $('btn-update-download')
  const inst = $('btn-update-install')
  const map: Record<string, string> = {
    idle: '未检查', checking: '检查中…', 'not-available': '已是最新版本',
    available: `发现新版本 ${updateVersion}`, downloaded: `更新已下载（${updateVersion}）`,
    error: '更新检查失败',
  }
  el.textContent = map[lastUpdatePhase] ?? lastUpdatePhase
  dl.hidden = lastUpdatePhase !== 'available'
  inst.hidden = lastUpdatePhase !== 'downloaded'
}

// ── bootstrap view ──
function envRow(key: string, label: string, st: { present: boolean; version: string | null; ok: boolean }, need: string): string {
  const cls = !st.present ? 'missing' : st.ok ? 'ok' : 'bad'
  const detail = !st.present ? `未安装（需要 ${need}）` : st.ok ? st.version! : `${st.version}（需要 ${need}）`
  return `<div class="env-row ${cls}"><span>${label}</span><span class="muted">${detail}</span></div>`
}

function initBootstrapView(): void {
  const envBox = $('bootstrap-env')
  const stepsBox = $('bootstrap-steps')
  const note = $('bootstrap-note')
  const renderEnv = (s: EnvStatus): void => {
    envBox.innerHTML =
      envRow('node', 'Node.js', s.node, '≥ 22.19') +
      envRow('dsh', 'dsh', s.dsh, '@deepseek-ai/dsh')
  }
  void window.dshApi.checkEnv().then((s) => { renderEnv(s); note.textContent = s.ready ? '环境就绪，可以直接开始。' : '检测到缺失项，可点击「开始引导安装」。' })
  $('btn-env-check').addEventListener('click', async () => {
    const s = await window.dshApi.checkEnv()
    renderEnv(s)
    note.textContent = s.ready ? '环境就绪 ✓' : '仍有缺失项。'
  })
  $('btn-bootstrap-run').addEventListener('click', async () => {
    if (!confirm('将执行自动下载/安装（Node.js 与全局 dsh）。继续？')) return
    note.textContent = '引导中…（可在设置页配置镜像加速）'
    await window.dshApi.runBootstrap()
  })
  $('btn-bootstrap-cancel').addEventListener('click', () => {
    void window.dshApi.cancelBootstrap()
    note.textContent = '已取消。可稍后重试。'
  })
  window.dshApi.onEvent((ev) => {
    const e = ev as { type: string; ev?: { type: string; step?: { id: string; label: string; status: string; detail?: string }; ok?: boolean; status?: EnvStatus; progress?: { id: string; percent: number } } }
    if (e.type !== 'bootstrap' || !e.ev) return
    const be = e.ev
    if (be.type === 'step' && be.step) {
      const s = be.step
      const badge = s.status === 'done' ? '✓' : s.status === 'error' ? '✗' : s.status === 'running' ? '…' : ''
      const existing = stepsBox.querySelector(`[data-step="${s.id}"]`) as HTMLElement | null
      const html = `<div class="env-row" data-step="${s.id}"><span>${badge} ${s.label}</span><span class="muted">${s.detail ?? ''}</span></div>`
      if (existing) existing.outerHTML = html
      else stepsBox.insertAdjacentHTML('beforeend', html)
    }
    if (be.type === 'progress' && be.progress) {
      const row = stepsBox.querySelector(`[data-step="${be.progress.id}"] .muted`) as HTMLElement | null
      if (row) row.textContent = `${be.progress.percent}%`
    }
    if (be.type === 'done') {
      if (be.ok) { note.textContent = '环境就绪 ✓ 即将启动…'; setTimeout(() => location.reload(), 1200) }
      else if (be.status) renderEnv(be.status)
      else note.textContent = '引导未完成，请检查上方步骤。'
    }
  })
}

// ── crash view ──
function initCrashView(): void {
  const detail = q.get('detail')
  $('crash-detail').textContent = detail ? decodeURIComponent(detail) : 'dsh server 已停止。'
  $('btn-crash-restart').addEventListener('click', async () => {
    await window.dshApi.restartServer()
    location.reload()
  })
  $('btn-crash-logs').addEventListener('click', () => void window.dshApi.openView('log'))
  $('btn-crash-quit').addEventListener('click', () => void window.dshApi.quitApp())
}

// ── global wiring ──
function init(): void {
  show(view)
  const badge = $('variant-badge')
  const fb = $('foot-variant')
  void window.dshApi.getState().then((s) => {
    const st = s as { variant: string; appVersion: string; server: { status: string; url: string | null } }
    badge.textContent = st.variant
    fb.textContent = `v${st.appVersion} · ${st.variant}`
    $('server-badge').textContent = `server: ${st.server.status}`
    $('foot-server').textContent = st.server.url ? `dsh: ${st.server.url}` : ''
  })
  window.dshApi.onEvent((ev) => {
    const e = ev as { type: string; status?: string; url?: string; detail?: string; settings?: Settings; status2?: { phase: string; version?: string } }
    if (e.type === 'server-status') {
      $('server-badge').textContent = `server: ${e.status ?? ''}`
      $('foot-server').textContent = ''
    }
    if (e.type === 'server-ready') $('foot-server').textContent = `dsh: ${e.url ?? ''}`
    if (e.type === 'settings' && e.settings && view === 'settings') {
      // refresh mirror/autodownload if changed elsewhere
    }
    if (e.type === 'update' && e.status2) {
      if (e.status2.version) updateVersion = e.status2.version
      lastUpdatePhase = e.status2.phase
      renderUpdateStatus()
      $('foot-update').textContent = lastUpdatePhase === 'downloaded' ? `更新就绪 ${updateVersion}` : ''
    }
  })
  $('btn-logs').addEventListener('click', () => void window.dshApi.openView('log'))
  $('btn-settings').addEventListener('click', () => void window.dshApi.openView('settings'))
}

if (view === 'log') initLogView()
else if (view === 'settings') initSettingsView()
else if (view === 'bootstrap') initBootstrapView()
else if (view === 'crash') initCrashView()
init()
