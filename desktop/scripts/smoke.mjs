// Standalone smoke test (no Electron): boots the dsh npm package the same way
// the app does — pre-allocated port, health probe readiness — and verifies the
// served HTML is the dsh Web UI. Usage: node scripts/smoke.mjs [--dsh <path>]
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const args = process.argv.slice(2)
const dshArg = args.includes('--dsh') ? args[args.indexOf('--dsh') + 1] : null
const candidates = dshArg
  ? [dshArg]
  : [
      join(root, 'resources', 'dev-dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(root, '..', '.verify-dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ]
const entry = candidates.find(existsSync)
if (!entry) {
  console.error('[smoke] dsh entry not found; run: node scripts/prepare-dsh.mjs')
  process.exit(2)
}

function preAllocatePort() {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer()
    srv.once('error', rejectP)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolveP(port))
    })
  })
}

async function probe(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status
  } catch { return -1 }
}

const port = await preAllocatePort()
console.log(`[smoke] entry=${entry}`)
console.log(`[smoke] port=${port}`)
// Isolated data root: never touch the real ~/.dsh or a running harness instance.
const dshHome = join(tmpdir(), `dsh-smoke-${Date.now()}`)
const child = spawn('node', [entry, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, DSH_HOME: dshHome },
})
let stdoutBuf = ''
let stderrBuf = ''
child.stdout.on('data', (b) => { stdoutBuf += b.toString() })
child.stderr.on('data', (b) => { stderrBuf += b.toString() })

const deadline = Date.now() + 30_000
let status = -1
while (Date.now() < deadline) {
  if (child.exitCode !== null) break
  status = await probe(`http://127.0.0.1:${port}/`, 1500)
  if (status === 200) break
  await new Promise((r) => setTimeout(r, 300))
}

const urlLine = stdoutBuf.split('\n').find((l) => l.includes('dsh web:')) ?? null
const html = status === 200 ? await (await fetch(`http://127.0.0.1:${port}/`)).text() : ''
const looksLikeUi = html.includes('__DSH_BOOT__') || /<title>.*[Dd]eep[ -]?[Ss]eek.*<\/title>/.test(html) || html.length > 2000

console.log(`[smoke] ready status=${status} urlLine=${urlLine ?? '(none)'}`)
console.log(`[smoke] ui-html=${looksLikeUi} htmlBytes=${html.length}`)
console.log('[smoke] stdout tail:', stdoutBuf.split('\n').slice(-4).join(' | '))
if (stderrBuf.trim()) console.log('[smoke] stderr tail:', stderrBuf.split('\n').slice(-3).join(' | '))

// cleanup
try { child.kill('SIGTERM') } catch { /* noop */ }
await new Promise((r) => setTimeout(r, 1500))
if (child.exitCode === null) {
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
}
await new Promise((r) => setTimeout(r, 800))

const ok = status === 200 && looksLikeUi
console.log(ok ? '[smoke] PASS' : '[smoke] FAIL')
process.exit(ok ? 0 : 1)
