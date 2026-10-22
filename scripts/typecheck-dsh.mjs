#!/usr/bin/env node
/**
 * Type-check this plugin against the seam packages of the *deployed* dsh
 * installation, not against whatever older versions npm happened to install in
 * this repo. This is the drift detector for dsh upgrades: run it after bumping
 * the dsh version and compare the error list with the accepted baseline.
 *
 * Seam resolution order:
 *   1. $DSH_SEAMS_DIR
 *   2. <dsh home>/profiles/node_modules/@deepseek-ai   (dsh's healed profile tree)
 * where <dsh home> is $DSH_HOME or ~/.dsh.
 *
 * Usage: node scripts/typecheck-dsh.mjs [--print-config]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seamsDir = process.env.DSH_SEAMS_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai')

/** Packages this plugin imports or receives through the host context. */
const SEAMS = [
  'cordis',
  'dsh-agent',
  'dsh-llm',
  'dsh-session',
  'dsh-tools',
  'dsh-skill-filesystem',
]

/** Extra entry points that are not `<pkg>/lib/types/index.d.ts`. */
const EXTRA_TYPES = {
  '@deepseek-ai/dsh-session/types': 'dsh-session/lib/types/types.d.ts',
}

function die(message) {
  console.error(`typecheck:dsh: ${message}`)
  process.exit(2)
}

if (!existsSync(seamsDir)) {
  die(`seam directory not found: ${seamsDir}\n`
    + 'set DSH_SEAMS_DIR to the installed dsh seam packages (…/profiles/node_modules/@deepseek-ai)')
}

const paths = {}
const missing = []
for (const seam of SEAMS) {
  const entry = join(seamsDir, seam, 'lib', 'types', 'index.d.ts')
  if (!existsSync(entry)) { missing.push(seam); continue }
  paths[`@deepseek-ai/${seam}`] = [entry]
}
if (missing.length > 0) die(`seam packages missing from ${seamsDir}: ${missing.join(', ')}`)

for (const [specifier, relative] of Object.entries(EXTRA_TYPES)) {
  const [pkg, ...rest] = relative.split('/')
  const absolute = join(seamsDir, pkg, ...rest)
  if (existsSync(absolute)) paths[specifier] = [absolute]
}

const versions = SEAMS
  .filter(seam => existsSync(join(seamsDir, seam, 'package.json')))
  .map(seam => `${seam}@${JSON.parse(readFileSync(join(seamsDir, seam, 'package.json'), 'utf8')).version}`)

const outDir = join(repoRoot, '.dsh-typecheck')
mkdirSync(outDir, { recursive: true })
const configPath = join(outDir, 'tsconfig.json')
writeFileSync(configPath, `${JSON.stringify({
  extends: '../tsconfig.json',
  compilerOptions: { noEmit: true, rootDir: '../src', paths },
  include: ['../src'],
}, null, 2)}\n`, 'utf8')

console.log(`typecheck:dsh: seams ${seamsDir}`)
console.log(`typecheck:dsh: ${versions.join('  ')}`)

if (process.argv.includes('--print-config')) {
  console.log(configPath)
  process.exit(0)
}

const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [tsc, '-p', configPath], { cwd: repoRoot, stdio: 'inherit' })
process.exit(result.status ?? 1)
