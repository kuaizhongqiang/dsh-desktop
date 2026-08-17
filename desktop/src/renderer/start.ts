// Startup page: shows boot progress; the main window navigates to the dsh URL
// once the server is ready, so this page mostly relays status.
declare const dshApi: {
  onEvent(cb: (ev: unknown) => void): () => void
  getState(): Promise<{ server: { status: string; url: string | null } }>
}

const statusEl = document.getElementById('start-status')!
const detailEl = document.getElementById('start-detail')!

function render(status: string, detail?: string): void {
  if (status === 'ready') {
    statusEl.textContent = 'dsh 已就绪，正在打开…'
  } else if (status === 'starting') {
    statusEl.textContent = '正在启动 dsh server…'
  } else if (status === 'crashed') {
    statusEl.textContent = 'dsh server 启动失败'
    detailEl.textContent = detail ?? ''
  } else {
    statusEl.textContent = `状态：${status}`
  }
}

void dshApi.getState().then((s) => render(s.server.status))
dshApi.onEvent((ev) => {
  const e = ev as { type: string; status?: string; detail?: string }
  if (e.type === 'server-status') render(e.status ?? '', e.detail)
  if (e.type === 'server-ready') render('ready')
})
