import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LF = String.fromCharCode(10)
const STDERR_PREVIEW = 500
export const DEFAULT_MAX_OUTPUT_BYTES = 1048576
const DEFAULT_TIMEOUTS = { surfacing: 2000, extraction: 30000 }
const EXTRACTION_HOOKS = new Set(['decision-extractor', 'handoff-generator', 'feedback-loop', 'precompact-extract', 'postcompact-inject'])
const LEVELS = { debug: 0, warn: 1, error: 2, off: 3 }

function errorMessage(error) {
  return error && error.message ? error.message : String(error)
}

function sessionIdOf(input) {
  const id = input && input.session_id
  return typeof id === 'string' && id !== '' ? id : ''
}

// Single internal parse: '' stdout -> 'empty', no parseable JSON line -> 'invalid'.
// L5: every parseable JSON line is considered and the LAST one that actually
// carries a string hookSpecificOutput.additionalContext wins, so a trailing
// context-free JSON line (or a non-JSON diagnostic line) can no longer discard
// an earlier context. Frozen result fields are unchanged.
function parseOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text === '') return { parseIssue: 'empty', context: '' }
  const lines = text.split(LF)
  let sawJson = false
  let found = false
  let context = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line === '') continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    sawJson = true
    if (found) continue
    const hookOutput = parsed && parsed.hookSpecificOutput
    const value = hookOutput && hookOutput.additionalContext
    if (typeof value === 'string') { context = value; found = true }
  }
  if (!sawJson) return { parseIssue: 'invalid', context: '' }
  return { parseIssue: null, context: context }
}

export function extractContext(stdout) {
  return parseOutput(stdout).context
}

// R-2: the shipped default carries no machine-specific path. The binary is
// resolved once at startup, first hit wins:
//   explicit config -> $CLAWMEM_BIN -> `clawmem` on PATH -> $HOME/.npm-global/bin/clawmem
// and the bare name last, so a system PATH can still serve it at spawn time.
// Every input is injectable (env / home / pathValue / isExecutable) so the chain
// is unit-testable without touching the real filesystem.
export function resolveClawmemBin(options) {
  const opts = options || {}
  const env = opts.env === undefined ? process.env : (opts.env || {})
  // R6 #4: trim, or a padded value is returned raw and the spawn then fails ENOENT.
  const configured = typeof opts.configured === 'string' && opts.configured.trim() !== '' ? opts.configured.trim() : null
  if (configured) return { bin: configured, source: 'config' }
  const fromEnv = typeof env.CLAWMEM_BIN === 'string' && env.CLAWMEM_BIN.trim() !== '' ? env.CLAWMEM_BIN.trim() : null
  if (fromEnv) return { bin: fromEnv, source: 'env' }
  const isExecutable = typeof opts.isExecutable === 'function' ? opts.isExecutable : defaultIsExecutable
  const pathValue = typeof opts.pathValue === 'string' ? opts.pathValue : (typeof env.PATH === 'string' ? env.PATH : '')
  const segments = pathValue.split(':')
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === '') continue
    // resolve() keeps a relative or '.' PATH segment usable downstream as a package-root candidate.
    const candidate = resolve(segments[i], 'clawmem')
    if (isExecutable(candidate)) return { bin: candidate, source: 'path' }
  }
  const home = typeof opts.home === 'string' && opts.home !== '' ? opts.home : (typeof env.HOME === 'string' ? env.HOME : '')
  if (home !== '') {
    const candidate = join(home, '.npm-global/bin/clawmem')
    if (isExecutable(candidate)) return { bin: candidate, source: 'home-npm-global' }
  }
  return { bin: 'clawmem', source: 'name' }
}

// R3 #8 / R6 #3: accessSync(X_OK) is true for a searchable DIRECTORY, so a directory
// named clawmem would be taken for the binary and every hook would fail EACCES.
function defaultIsExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch { return false }
}

/** True only for a regular file: a directory (or a FIFO/socket) is never a binary. */
export function isRegularFile(candidate) {
  try { return statSync(candidate).isFile() } catch { return false }
}

export function createClawmemClient(options) {
  const opts = options || {}
  const resolvedBin = resolveClawmemBin({ configured: opts.bin, env: opts.env, home: opts.home, pathValue: opts.pathValue, isExecutable: opts.isExecutable })
  const bin = resolvedBin.bin
  // A caller that already resolved the chain can hand the provenance back (apply()
  // resolves once and reuses it for the fallback client and the skill root).
  const binSource = typeof opts.binSource === 'string' && opts.binSource !== '' ? opts.binSource : resolvedBin.source
  const logger = opts.logger
  const merged = Object.assign({}, DEFAULT_TIMEOUTS, opts.timeouts || {})
  // Unknown levels fall back to 'warn' so a bad config never silences failures (D-18).
  const level = Object.prototype.hasOwnProperty.call(LEVELS, opts.level) ? opts.level : 'warn'
  const threshold = LEVELS[level]
  const logStderr = opts.logStderr === undefined ? true : !!opts.logStderr
  const profile = typeof opts.profile === 'string' && opts.profile !== '' ? opts.profile : ''
  const maxOutputBytes = Number.isFinite(opts.maxOutputBytes) && opts.maxOutputBytes >= 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  /** Emit one gated line; returns true only when the logger was actually called,
   *  so runHook can tell the caller it already reported this run (F1). */
  function emit(messageLevel, message) {
    if (!logger || LEVELS[messageLevel] < threshold) return false
    let fn = typeof logger[messageLevel] === 'function' ? logger[messageLevel] : null
    if (!fn && typeof logger.warn === 'function') fn = logger.warn
    if (!fn && typeof logger.error === 'function') fn = logger.error
    if (!fn) return false
    try { fn.call(logger, message); return true } catch { /* logging must never throw into the loop */ return false }
  }

  function timeoutFor(name) {
    return EXTRACTION_HOOKS.has(name) ? merged.extraction : merged.surfacing
  }

  function runHook(name, input, timeoutMs) {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : timeoutFor(name)
    const sid = sessionIdOf(input)
    const where = 'hook ' + name + (sid ? ' session=' + sid : '')
    return new Promise(function (resolve) {
      const started = Date.now()
      const chunks = []
      let outBytes = 0
      let stderr = ''
      let stderrBytes = 0
      let stderrCapped = false
      let oversized = false
      let timedOut = false
      let settled = false
      let logged = false
      let child
      let timer
      function elapsed() { return Date.now() - started }
      /** Report an anomaly and remember that this run was logged by the client. */
      function note(messageLevel, message) { if (emit(messageLevel, message)) logged = true }
      function finish(ok, code, signal, parsed) {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const stdout = Buffer.concat(chunks).toString('utf8')
        const outcome = parsed || { parseIssue: null, context: '' }
        resolve({
          ok: ok,
          stdout: stdout,
          stderr: stderr,
          code: code,
          signal: signal === undefined ? null : signal,
          ms: elapsed(),
          timedOut: timedOut,
          oversized: oversized,
          logged: logged,
          parseIssue: outcome.parseIssue,
          context: outcome.context
        })
      }
      try {
        // L6: own group leader (detached) so a forking wrapper's descendants can
        // be signalled with one group kill; stdio stays piped and captured.
        // setsid() makes the child its own process-group AND session leader, so a
        // process-GROUP-directed signal aimed at dsh-web.service's group no longer
        // reaches hook children. Cgroup-scoped termination still does: the unit
        // sets no KillMode, so systemd's control-group default applies and
        // 'systemctl --user restart' reaps detached hook children as well.
        const spawnOptions = { stdio: ['pipe', 'pipe', 'pipe'], detached: true }
        if (profile) spawnOptions.env = Object.assign({}, process.env, { CLAWMEM_PROFILE: profile })
        child = spawn(bin, ['hook', name], spawnOptions)
      } catch (error) {
        note('error', 'dsh-clawmem: ' + where + ' spawn failed after ' + elapsed() + 'ms: ' + errorMessage(error))
        finish(false, null, null)
        return
      }
      timer = setTimeout(function () {
        if (settled) return
        timedOut = true
        note('error', 'dsh-clawmem: ' + where + ' timed out after ' + elapsed() + 'ms (limit ' + limit + 'ms)')
        // L6: SIGKILL the whole process group (the direct child is its leader), so a
        // forking wrapper cannot leave a grandchild holding the stdio pipes. Fall
        // back to the direct child when the group signal fails (ESRCH/EPERM/NaN pid).
        // Do NOT replace this with a /proc PPID walk: a double-forked grandchild
        // reparents to init and vanishes from the PPID chain while still sharing the
        // group, so the walk misses it (measured: detached + kill(-pid) reaps 3/3,
        // the PPID walk leaks 3/3). tests/clawmem.test.mjs 'L6c: ...' locks this in.
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
        finish(false, null, null)
      }, limit)
      child.stdout.on('data', function (chunk) {
        if (oversized) return
        const remaining = maxOutputBytes - outBytes
        if (chunk.length <= remaining) { chunks.push(chunk); outBytes += chunk.length; return }
        if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); outBytes += remaining }
        oversized = true
      })
      // F7c: bound stderr exactly like stdout; the cap is reported at most once.
      child.stderr.on('data', function (chunk) {
        if (stderrCapped) return
        const remaining = maxOutputBytes - stderrBytes
        if (chunk.length <= remaining) { stderr += chunk.toString(); stderrBytes += chunk.length; return }
        if (remaining > 0) { stderr += chunk.subarray(0, remaining).toString(); stderrBytes += remaining }
        stderrCapped = true
        note('warn', 'dsh-clawmem: ' + where + ' stderr exceeded ' + maxOutputBytes + ' bytes (capped) after ' + elapsed() + 'ms')
      })
      // Absorb async stdin stream errors: the child 'error'/'close' path already reports them.
      child.stdin.on('error', function () {})
      child.on('error', function (error) {
        if (settled) return
        note('error', 'dsh-clawmem: ' + where + ' error after ' + elapsed() + 'ms: ' + errorMessage(error))
        finish(false, null, null)
      })
      child.on('close', function (code, signal) {
        if (settled) return
        const ms = elapsed()
        if (code !== 0) {
          note('error', 'dsh-clawmem: ' + where + ' exited code=' + code + ' signal=' + (signal || 'none') + ' after ' + ms + 'ms' + (logStderr && stderr ? ' stderr=' + stderr.slice(0, STDERR_PREVIEW) : ''))
          finish(false, code, signal)
          return
        }
        if (oversized) {
          note('warn', 'dsh-clawmem: ' + where + ' output exceeded ' + maxOutputBytes + ' bytes (capped) after ' + ms + 'ms')
          finish(false, code, signal)
          return
        }
        const parsed = parseOutput(Buffer.concat(chunks).toString('utf8'))
        if (parsed.parseIssue === 'empty') note('warn', 'dsh-clawmem: ' + where + ' produced empty stdout after ' + ms + 'ms')
        else if (parsed.parseIssue === 'invalid') note('warn', 'dsh-clawmem: ' + where + ' produced invalid JSON stdout after ' + ms + 'ms')
        finish(true, code, signal, parsed)
      })
      try { child.stdin.end(JSON.stringify(input || {})) } catch (error) { note('error', 'dsh-clawmem: ' + where + ' stdin failed after ' + elapsed() + 'ms: ' + errorMessage(error)) }
    })
  }
  // R-2: expose what was resolved so the host can reuse it (skill package root)
  // and report it once, instead of re-deriving it.
  return { runHook: runHook, bin: bin, binSource: binSource }
}
