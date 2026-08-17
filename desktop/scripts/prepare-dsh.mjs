// Prepare dsh runtime into desktop/resources/dsh from the npm-locked package (D6).
// Usage: node scripts/prepare-dsh.mjs [--prefix <dir>] [--registry <url>]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../config.json' with { type: 'json' }

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const args = process.argv.slice(2)
const prefixArg = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : join(root, 'resources', 'dsh')
const registryArg = args.includes('--registry') ? args[args.indexOf('--registry') + 1] : null
const prefix = resolve(prefixArg)

mkdirSync(prefix, { recursive: true })

const pkg = `@deepseek-ai/dsh@${config.dshVersion}`
console.log(`[prepare-dsh] installing ${pkg} -> ${prefix}`)
const cmdArgs = ['install', '--prefix', prefix, '--no-audit', '--no-fund', pkg]
if (registryArg) cmdArgs.push('--registry', registryArg)
execFileSync('npm', cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' })

const entry = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(entry)) {
  console.error(`[prepare-dsh] FAILED: entry not found: ${entry}`)
  process.exit(1)
}
const ui = join(prefix, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
console.log(`[prepare-dsh] entry: ${entry}`)
console.log(`[prepare-dsh] web-ui bundled: ${existsSync(ui)}`)
console.log('[prepare-dsh] ok')
