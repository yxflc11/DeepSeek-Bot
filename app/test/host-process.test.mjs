import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { HostProcess } from '../src/host-process.mjs'

function fixture(t, script, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-host-process-'))
  const entry = join(root, 'host.mjs')
  writeFileSync(entry, `import { writeFileSync, appendFileSync } from 'node:fs'\nwriteFileSync('pid', String(process.pid))\n${script}`)
  const failures = []
  const host = new HostProcess({
    entry, cwd: root, env: {}, pnpm: '', onFailure: error => failures.push(error), ...options,
  })
  t.after(async () => { await host.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { root, host, failures }
}
const shutdown = `process.on('message', message => { if (message.type === 'shutdown') { appendFileSync('stops', '1'); process.exit(0) } })`
const assertGone = root => assert.throws(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0), { code: 'ESRCH' })

test('ready clears the startup deadline and concurrent stops share cleanup', async t => {
  const { root, host, failures } = fixture(t, `${shutdown}\nprocess.send({ type: 'ready', url: 'http://127.0.0.1/', injections: [] })`, { startupTimeoutMs: 500 })
  const started = host.start()
  assert.equal(host.start(), started)
  assert.deepEqual(await started, { url: 'http://127.0.0.1/', injections: [] })
  await sleep(550)
  assert.deepEqual(failures, [])
  const stopped = host.stop()
  assert.equal(host.stop(), stopped)
  await stopped
  assert.equal(readFileSync(join(root, 'stops'), 'utf8'), '1')
  assertGone(root)
})

test('the import check keeps its independent lifetime', async t => {
  const { host, failures } = fixture(t, `${shutdown}\nprocess.send({ type: 'checked', unreadable: ['session-newer'] })`, { startupTimeoutMs: 1, env: { DS_BOT_CHECK: 'synthetic-session-list' } })
  assert.deepEqual(await host.start(), { unreadable: ['session-newer'] })
  await sleep(30)
  assert.deepEqual(failures, [])
})

test('fatal startup rejects once and automatically stops the child', async t => {
  const { root, host, failures } = fixture(t, `${shutdown}\nprocess.send({ type: 'fatal', message: 'The Bot services did not start.' })\nprocess.send({ type: 'ready', url: 'late' })`)
  await assert.rejects(host.start(), /Bot services did not start/u)
  await host.stop()
  assert.equal(failures.length, 1)
  assertGone(root)
})

test('a Host that never reports ready times out and is reaped', async t => {
  const { root, host, failures } = fixture(t, shutdown, { startupTimeoutMs: 500 })
  await assert.rejects(host.start(), /startup timeout/u)
  await host.stop()
  assert.equal(failures.length, 1)
  assertGone(root)
})

test('a timed-out Host that ignores shutdown is killed and reaped', { timeout: 25_000 }, async t => {
  const { root, host, failures } = fixture(t, "process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)", { startupTimeoutMs: 500 })
  await assert.rejects(host.start(), /startup timeout/u)
  await host.stop()
  assert.equal(failures.length, 1)
  assertGone(root)
})

test('an inherited log pipe cannot keep a stopped Host alive', { timeout: 10_000 }, async t => {
  const { root, host, failures } = fixture(t, `
import { spawn } from 'node:child_process'
const logger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] })
writeFileSync('descendant', String(logger.pid))
logger.unref()
${shutdown}
process.send({ type: 'ready', url: 'http://127.0.0.1/', injections: [] })
`)
  await host.start()
  const descendant = Number(readFileSync(join(root, 'descendant'), 'utf8'))
  let timer
  try {
    await Promise.race([
      host.stop(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop waited for an inherited log pipe')), 2000) }),
    ])
    assertGone(root)
    assert.deepEqual(failures, [])
  } finally {
    clearTimeout(timer)
    // This fixture owns the extra process; HostProcess owns only its direct Host.
    try { process.kill(descendant, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await host.stop()
  }
})

test('an early exit is a failure, not readiness', async t => {
  const { root, host, failures } = fixture(t, 'process.exit(7)')
  await assert.rejects(host.start(), /exit 7/u)
  await host.stop()
  assert.equal(failures.length, 1)
  assertGone(root)
})

test('a spawn failure rejects startup and completes cleanup', async t => {
  const { host, failures } = fixture(t, '', { cwd: join(tmpdir(), `ds-bot-missing-${process.pid}-${Date.now()}`, 'missing') })
  await assert.rejects(host.start(), { code: 'ENOENT' })
  await host.stop()
  assert.equal(failures.length, 1)
})

test('stopping during startup rejects the pending start without reporting a failure', async t => {
  const { host, failures } = fixture(t, `${shutdown}\nsetTimeout(() => process.send({ type: 'ready', url: 'late' }), 1000)`)
  const rejected = assert.rejects(host.start(), /startup was stopped/u)
  await host.stop()
  await rejected
  assert.deepEqual(failures, [])
})
