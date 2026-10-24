import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { HostProcess } from '../src/host-process.mjs'

const app = dirname(dirname(fileURLToPath(import.meta.url)))

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function assertPortReleased(port) {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
}

function running(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function assertExited(pid) {
  const deadline = Date.now() + 20_000
  while (running(pid) && Date.now() < deadline) await sleep(25)
  assert.equal(running(pid), false, 'the failed Host exits without another stop request')
}

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-host-startup-'))
  const pidFile = join(home, 'host.pid')
  let host, port
  t.after(async () => {
    try {
      await host?.stop()
      if (existsSync(pidFile)) assert.equal(running(Number(readFileSync(pidFile, 'utf8'))), false, 'the Host process has exited')
      if (port !== undefined) await assertPortReleased(port)
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    }
  })
  port = await unusedPort()
  const cwd = join(home, 'profiles', 'ds-bot')
  mkdirSync(cwd, { recursive: true })
  // This wrapper records only the child PID; startup still executes the real Host and DSH.
  const entry = join(home, 'host-wrapper.mjs')
  writeFileSync(entry, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nawait import(${JSON.stringify(pathToFileURL(join(app, 'src', 'host.mjs')).href)})\n`)
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  // Neither inherited model keys nor the user's home/config directories enter this Host.
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    DSH_HOME: home, DS_BOT_APP: '1', DS_BOT_PORT: String(port), DS_BOT_WORKSPACE: join(home, 'workspace'),
  })
  const failures = []
  host = new HostProcess({
    entry, cwd, env, pnpm: join(app, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    onFailure: error => failures.push(error), startupTimeoutMs: 120_000,
  })
  return { home, cwd, host, failures, port, pid: () => Number(readFileSync(pidFile, 'utf8')) }
}

test('the real Bot profile becomes ready without a configured model and releases its Host', { timeout: 180_000 }, async t => {
  const f = await fixture(t)
  const ready = await f.host.start()
  assert.equal(new URL(ready.url).port, String(f.port))
  assert.ok(Array.isArray(ready.injections))
  assert.deepEqual(f.failures, [])
  await f.host.stop()
  assert.equal(running(f.pid()), false)
  await assertPortReleased(f.port)
})

test('a valid session log in the wrong directory refuses readiness without changing its bytes', { timeout: 180_000 }, async t => {
  const f = await fixture(t)
  const id = 'session-fixture'
  const header = { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  // A no-cwd Session belongs under _no-cwd. Moving it to _deleted reproduces #516.
  const file = join(f.home, 'sessions', '_deleted', id, 'session.v4.jsonl.zstd')
  const bytes = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  await assert.rejects(f.host.start(), /Bot services did not start|Bot API did not become ready/)
  await assertExited(f.pid())
  assert.equal(f.failures.length, 1)
  assert.deepEqual(readFileSync(file), bytes, 'startup does not repair, move or truncate the original log')
  await assertPortReleased(f.port)
})

test('a profile with the Bot plugin disabled does not report a working Bot app', { timeout: 180_000 }, async t => {
  const f = await fixture(t)
  writeFileSync(join(f.cwd, 'cordis.patch.yml'), '- id: bot\n  disabled: true\n')
  await assert.rejects(f.host.start(), /Bot API did not become ready/)
  await assertExited(f.pid())
  assert.equal(f.failures.length, 1)
  await assertPortReleased(f.port)
})
