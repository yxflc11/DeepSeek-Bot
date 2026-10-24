// Product readiness is stricter than DSH's best-effort profile boot. Adapted from
// OpenBot's bounded Desktop startup checks (MIT); see NOTICE.

const MAX_RESPONSE_BYTES = 4096
const STARTUP_HELP = 'Review the Host startup diagnostics. If session folders were moved manually, quit the app and keep backups outside the sessions folder; do not edit or delete the session logs.'

async function readResponse(response, signal) {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error('The Bot API did not return a JSON response.')
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('The Bot readiness response is too large.')
      chunks.push(value)
    }
    signal.throwIfAborted()
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (result?.ok !== true || !Array.isArray(result.value?.efforts) || result.value.efforts.length !== 0) {
      throw new Error('The Bot API did not complete its readiness check.')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

/** Check the settled profile through public Cordis services and the existing Bot API. */
export async function checkBotReady(ctx, { timeoutMs = 30_000, signal } = {}) {
  const missing = ['workspaceRegistry', 'sessionController', 'webServer', 'connection'].filter(name => ctx.get(name) === undefined)
  if (missing.length > 0) throw new Error(`The Bot services did not start: ${missing.join(', ')}. ${STARTUP_HELP}`)
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => { controller.abort(signal.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  let timer
  const interrupted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    timer = setTimeout(() => controller.abort(new Error('The Bot API readiness check timed out.')), timeoutMs)
  })
  const connection = ctx.get('connection')
  // An empty model reference returns no efforts without calling a provider or bootstrapping
  // a Bot. The handler still waits for the team store and proves that /api/bot is mounted.
  const probe = (async () => {
    const response = await connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'efforts', payload: { ref: '' } }),
      signal: controller.signal,
    }), connection.browserPeer)
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {})
      controller.signal.throwIfAborted()
    }
    await readResponse(response, controller.signal)
  })()
  try {
    await Promise.race([probe, interrupted])
    controller.signal.throwIfAborted()
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    // Neither an API error body nor a plugin exception belongs in a startup dialog.
    throw new Error(`The Bot API did not become ready. ${STARTUP_HELP}`, { cause: error })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}
