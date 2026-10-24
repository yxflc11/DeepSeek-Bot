// Runs the Host in Electron's Node mode and owns its lifetime.
// Follows DeepSeek Harness apps/desktop/src/host-process.ts (MIT); see NOTICE.
import { spawn } from 'node:child_process'

const STDERR_TAIL_CHARS = 8 * 1024
const STARTUP_TIMEOUT_MS = 120_000

// The web server prints its launch URL, and the launch token in it opens the Host.
const redact = (text) => text.replace(/([?&]token=)[^&\s]+/gu, '$1<hidden>')

const settlesWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(false) }, ms)
  void promise.then(() => { clearTimeout(timer); resolve(true) })
})

export class HostProcess {
  #options
  #child
  #ready
  #exit
  #stderr = ''
  #stopping = false
  #failed = false
  #timer
  #reject
  #stop

  /**
   * @param {{ entry: string, cwd: string, env: NodeJS.ProcessEnv, pnpm: string, onFailure: (error: Error) => void, startupTimeoutMs?: number }} options
   *   `onFailure` receives the first unexpected failure, also after the Host was ready.
   */
  constructor(options) { this.#options = options }

  /**
   * @returns {Promise<{ url: string, injections: unknown[] } | { unreadable: string[] }>} the Host's launch URL
   *   and index injections; for the first-run check, the Sessions it cannot read
   */
  start() {
    this.#ready ??= new Promise((resolve, reject) => {
      this.#reject = reject
      const { entry, cwd, env, pnpm } = this.#options
      const child = spawn(process.execPath, ['--expose-internals', entry, pnpm], {
        cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.#child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { process.stdout.write(redact(chunk)) })
      child.stderr.on('data', (chunk) => {
        process.stderr.write(redact(chunk))
        this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS)
      })
      child.on('message', (message) => {
        if (this.#stopping || this.#failed) return
        if (message?.type === 'ready' || message?.type === 'checked') {
          clearTimeout(this.#timer)
          this.#reject = undefined
          resolve(message.type === 'ready' ? { url: message.url, injections: message.injections } : { unreadable: message.unreadable })
        }
        else if (message?.type === 'fatal') this.#fail(new Error(message.message), reject)
      })
      child.once('error', (error) => { this.#fail(error, reject) })
      this.#exit = new Promise((done) => {
        // A descendant can inherit the log pipes. Its lifetime must not delay Host exit.
        child.once('exit', (code) => {
          const tail = redact(this.#stderr.trim())
          this.#fail(new Error(`The DSH Host stopped (exit ${String(code)})${tail === '' ? '' : `:\n${tail}`}`), reject)
          done()
        })
        child.once('error', () => { if (child.pid === undefined) done() })
      })
      // The import check reads every retained chat, so it keeps its separate lifetime.
      if (!env.DS_BOT_CHECK) this.#timer = setTimeout(() => {
        this.#fail(new Error('The DSH Host did not become ready before the startup timeout. Review the Host startup diagnostics.'), reject)
      }, this.#options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
    })
    return this.#ready
  }

  /** Ask the Host to shut down, then end it if it does not exit in time. */
  stop() {
    return this.#stop ??= this.#stopChild()
  }

  async #stopChild() {
    const child = this.#child
    if (child === undefined) return
    this.#stopping = true
    clearTimeout(this.#timer)
    this.#reject?.(new Error('The DSH Host startup was stopped.'))
    this.#reject = undefined
    if (child.pid !== undefined && child.connected) child.send({ type: 'shutdown' }, (error) => { if (error) console.error(error) })
    if (!await settlesWithin(this.#exit, 10_000)) child.kill()
    if (!await settlesWithin(this.#exit, 5_000)) {
      child.kill('SIGKILL')
      await this.#exit
    }
    child.stdout.destroy()
    child.stderr.destroy()
    this.#child = undefined
  }

  #fail(error, reject) {
    clearTimeout(this.#timer)
    this.#reject = undefined
    reject(error)
    if (this.#failed || this.#stopping) return
    this.#failed = true
    void this.stop()
    this.#options.onFailure(error)
  }
}
