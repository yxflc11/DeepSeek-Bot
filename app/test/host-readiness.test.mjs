import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { checkBotReady } from '../src/host-readiness.mjs'

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const ready = () => json({ ok: true, value: { efforts: [] } })
function context(fetch = async () => ready(), missing = []) {
  const peer = {}
  const connection = {
    browserPeer: peer,
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api')
      return { fetch: (request, actualPeer) => {
        assert.equal(actualPeer, peer)
        return fetch(request)
      } }
    },
  }
  return { get: name => missing.includes(name) ? undefined : name === 'connection' ? connection : {} }
}

test('probes the mounted Bot route without selecting a model or bootstrapping a Bot', async () => {
  let calls = 0
  await checkBotReady(context(async request => {
    calls++
    assert.equal(request.url, 'http://127.0.0.1/api/bot')
    assert.equal(request.method, 'POST')
    assert.deepEqual(await request.json(), { endpoint: 'efforts', payload: { ref: '' } })
    await sleep(10)
    return ready()
  }))
  assert.equal(calls, 1)
})

test('a listening web server cannot hide missing session storage services', async () => {
  await assert.rejects(checkBotReady(context(() => assert.fail('must not dispatch'), ['workspaceRegistry', 'sessionController'])), error => {
    assert.match(error.message, /workspaceRegistry, sessionController/u)
    assert.match(error.message, /outside the sessions folder/u)
    return true
  })
})

for (const [name, response] of [
  ['unregistered route', () => new Response('Not Found', { status: 404 })],
  ['SPA fallback', () => new Response('<html>DSH</html>', { headers: { 'content-type': 'text/html' } })],
  ['malformed JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['wrong JSON media type', () => new Response('{}', { headers: { 'content-type': 'application/jsonish' } })],
  ['API refusal', () => json({ ok: false, error: { message: 'private diagnostic fixture' } })],
  ['wrong API response', () => json({ ok: true, value: {} })],
  ['unexpected model data', () => json({ ok: true, value: { efforts: ['high'] } })],
]) {
  test(`refuses ${name} without displaying raw response data`, async () => {
    await assert.rejects(checkBotReady(context(async () => response())), error => {
      assert.match(error.message, /Bot API did not become ready/u)
      assert.doesNotMatch(error.message, /private diagnostic fixture|<html>/u)
      return true
    })
  })
}

test('counts actual streamed bytes even with a false Content-Length and cancels overflow', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4097)) },
    cancel() { cancelled = true; return new Promise(() => {}) },
  }), { headers: { 'content-type': 'application/json', 'content-length': '1' } })
  await assert.rejects(checkBotReady(context(async () => response), { timeoutMs: 1000 }), error => {
    assert.match(error.cause.message, /too large/u)
    return true
  })
  assert.equal(cancelled, true)
})

test('bounds a handler that never settles and aborts its Request', async () => {
  let signal
  await assert.rejects(checkBotReady(context(request => {
    signal = request.signal
    return new Promise(() => {})
  }), { timeoutMs: 20 }), /Bot API did not become ready/u)
  assert.equal(signal.aborted, true)
})

test('bounds a body that never ends and does not await an uncooperative cancellation', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}) } }), {
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(checkBotReady(context(async () => response), { timeoutMs: 20 }), /Bot API did not become ready/u)
  assert.equal(cancelled, true)
})

test('shutdown interrupts a pending probe and a late response cannot report ready', async () => {
  const stop = new AbortController()
  let finish
  const pending = checkBotReady(context(() => new Promise(resolve => { finish = resolve })), { signal: stop.signal })
  const stopped = assert.rejects(pending, /fixture stopped/u)
  stop.abort(new Error('fixture stopped'))
  await stopped
  let cancelled = false
  finish(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await sleep(0)
  assert.equal(cancelled, true)
})

test('an already stopped launch does not dispatch', async () => {
  const stop = AbortSignal.abort(new Error('already stopped'))
  await assert.rejects(checkBotReady(context(() => assert.fail('must not dispatch')), { signal: stop }), /already stopped/u)
})
