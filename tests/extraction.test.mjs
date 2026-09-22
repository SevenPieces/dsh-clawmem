// tests/extraction.test.mjs
// M2: turn-stopping is serial and extraction is detached via ctx.jobs (D-5),
//     with a guarded promise fallback that can never leave an unhandled rejection (H4).
// M1: coalesce / maxConcurrentJobs / forceBeforeCompaction are honored (D-19).
// M3: listeners and the rotation interval are effect-scoped and closed on disposal.
// F1/F7a/F7b (round 2): one visible log line per hook failure, a logged+rethrown
//     downstream next(), and debug logging for the two defensive catch fallbacks.
//
// Fix -> test map (round 3; keep this current so a revert audit is unambiguous):
//   F1  timeout failure       -> 'one hook failure produces exactly one visible warn/error line...'
//   F1  non-zero-exit failure -> 'a non-zero hook exit produces exactly one visible warn/error line...'
//   F7a downstream next()     -> 'a downstream next() throw is logged once and still propagates (F7a)'
//   F7b lineage accessor      -> 'a throwing lineage accessor is contained, logged at debug...'
//   F7b transcripts.pathFor   -> 'a throwing transcripts.pathFor is contained, logged at debug...'
//   H4  guarded detach        -> 'guardDetached swallows...' + 'a malformed extraction.hooks config...'
//   M1  cap/coalesce          -> 'maxConcurrentJobs 1 caps...' + 'coalesce true runs exactly one extra time...'
//   R8  job-registry warn-once -> 'a permanently unavailable job registry warns exactly once per plugin instance (round 8)'
//                              + 'later job-registry failures drop to debug and are suppressed at warn level (round 8)'
//                              + 'a successful job submission clears the warn-once flag...'
// Round 12:
//   L1  cross-session coalesce -> 'L1: a session blocked by the cap runs its coalesced follow-up when a slot frees'
//   L2  sweep at activation    -> 'L2: an aged transcript dir is pruned by one sweep at activation'
//   L4  absent jobs registry   -> 'L4: no jobs service announces the guarded detached promise once at debug'
//                              + 'L4: with no jobs service nothing is emitted at warn level'
//                              + 'L4: a throwing jobs registry keeps the round-8 warn-once and emits no absent note'
// Round 13:
//   L1-fix drain keeps blocked entries -> 'R13: an own coalesced follow-up survives a foreign run finishing first (cap 2)'
//                              + 'R13: three interleaved sessions neither lose nor double-run their coalesced follow-ups (cap 2)'
// Round 14:
//   drain throw-safe          -> 'R14: a throw inside a drain pass restores the queued remainder instead of losing it'
//                              + both R13 tests above widened to 1000 ms runs / 200-250 ms gaps
// Round 15:
//   F1  drain slot release    -> 'R15/F1: one throw inside a drain pass releases the slot and the entries behind still run'
//                              + 'R15/F1: two throws inside drain passes do not wedge extraction permanently'
//   F2  empty transcript path -> 'F2/L7: an empty transcript path creates no memory dir, warns nothing and still attempts the hook'
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as plugin from '../lib/index.js'

const { apply, guardDetached } = plugin

const LF = String.fromCharCode(10)
const WINDOW = 1000000

const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-extract-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const hook = process.argv[3]',
    "let body = ''",
    'for await (const chunk of process.stdin) body += chunk',
    "let sid = ''",
    "try { sid = String((JSON.parse(body || '{}') || {}).session_id || '') } catch {}",
    "const delay = Number(process.env.DSH_TEST_DELAY || '0')",
    "const log = process.env.DSH_TEST_LOG",
    "if (log) appendFileSync(log, 'start ' + hook + String.fromCharCode(10))",
    "if (log && sid) appendFileSync(log, 'sid ' + hook + ' ' + sid + String.fromCharCode(10))",
    'await new Promise((resolve) => setTimeout(resolve, delay))',
    "if (log) appendFileSync(log, 'end ' + hook + String.fromCharCode(10))",
    "if (process.env.DSH_TEST_FAIL === hook) process.exit(4)",
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'CTX-' + hook } }))",
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  const logPath = join(root, 'hooks.log')
  writeFileSync(logPath, '')
  process.env.DSH_TEST_LOG = logPath
  process.env.DSH_TEST_DELAY = '0'
  process.env.DSH_TEST_FAIL = ''
  return { root, bin, logPath }
}

function logLines(env) {
  return readFileSync(env.logPath, 'utf8').split(LF).filter(Boolean)
}
function startCount(env, hook) {
  return logLines(env).filter((line) => line === 'start ' + hook).length
}
/** Spawns of one hook attributed to one session id (L1). */
function startCountFor(env, hook, sessionId) {
  return logLines(env).filter((line) => line === 'sid ' + hook + ' ' + sessionId).length
}
/** Highest number of simultaneously open processes for one hook. */
function maxConcurrency(env, hook) {
  let open = 0
  let peak = 0
  for (const line of logLines(env)) {
    if (line === 'start ' + hook) { open += 1; peak = Math.max(peak, open) }
    else if (line === 'end ' + hook) open -= 1
  }
  return peak
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000)
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

function makeCtx(projections, extra) {
  const handlers = new Map()
  const logs = []
  const effects = []
  const registered = { disposers: [] }
  const ctx = Object.assign({
    logger: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      error: (m) => logs.push('error ' + m),
      debug: (m) => logs.push('debug ' + m),
    },
    on(event, fn, options) {
      const list = handlers.get(event) || []
      list.push({ fn, options })
      handlers.set(event, list)
      const disposer = () => { const current = handlers.get(event) || []; handlers.set(event, current.filter((entry) => entry.fn !== fn)) }
      registered.disposers.push(disposer)
      return disposer
    },
    skills: { register: () => () => {}, registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    sessionProjections: projections,
    effect(execute, label) {
      const disposer = execute()
      effects.push(label)
      const wrapped = typeof disposer === 'function' ? disposer : () => {}
      registered.disposers.push(wrapped)
      return wrapped
    },
    get: () => undefined,
  }, extra || {})
  return { ctx, handlers, logs, effects, registered }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const turnStopping = (session) => ({ agent: { session } })
const enter = async () => ({ kind: 'enter', messages: [] })
const SESSION = { id: 'sess-extract' }

function baseConfig(env, extra) {
  return Object.assign({
    clawmemBin: env.bin,
    logging: { level: 'debug' },
    surfacing: { enabled: false },
    transcript: { dir: env.root, rotation: { enabled: false } },
    extraction: { minIntervalMs: 0, minNewMessages: 0 },
  }, extra || {})
}

test('agent/turn-stopping is registered serial (6.2)', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env))
  const entry = handlers.get('agent/turn-stopping')[0]
  assert.equal(entry.options.serial, true)
  const preStep = handlers.get('agent/pre-step')[0]
  assert.equal(preStep.options.prepend, true)
  rmSync(env.root, { recursive: true, force: true })
})

test('guardDetached swallows a sync throw and a rejection (H4)', async () => {
  const seen = []
  unhandled.length = 0
  guardDetached(() => { throw new Error('sync boom') }, (error) => seen.push(String(error && error.message)))
  guardDetached(() => Promise.reject(new Error('async boom')), (error) => seen.push(String(error && error.message)))
  await sleep(50)
  assert.deepEqual(seen.sort(), ['async boom', 'sync boom'])
  assert.deepEqual(unhandled, [], 'no unhandled rejection escapes')
})

test('a malformed extraction.hooks config never produces an unhandled rejection (H4)', async () => {
  const env = setup()
  unhandled.length = 0
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  // H4 specifically: a hooks value that survives the M6 config repair
  // (Array.isArray with length > 0) but makes runExtract itself reject. Only the
  // guarded-detach catch can turn that rejection into a log line; with the guard
  // reverted the rejection is silently swallowed (and this test fails).
  const hooks = ['decision-extractor']
  Object.defineProperty(hooks, 'filter', { value: function () { return this } })
  Object.defineProperty(hooks, 'map', { value: function () { throw new Error('hooks map boom') } })
  apply(ctx, Object.assign(baseConfig(env), { extraction: { hooks: hooks, minIntervalMs: 0, minNewMessages: 0 } }))
  await handlers.get('agent/turn-stopping')[0].fn(turnStopping(SESSION))
  await sleep(250)
  assert.deepEqual(unhandled, [], 'host survives a rejecting detached extraction')
  assert.equal(logLines(env).length, 0, 'the rejection happened before any hook could spawn')
  assert.ok(logs.some((line) => /^warn /.test(line) && /clawmem-extract .* failed/.test(line) && /hooks map boom/.test(line)),
    'the guarded detach path logged the rejection: ' + JSON.stringify(logs))
  rmSync(env.root, { recursive: true, force: true })
})

test('maxConcurrentJobs 1 caps in-flight extraction runs', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '200'
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: false, maxConcurrentJobs: 1 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  await stop(turnStopping({ id: 'sess-a' }))
  await waitFor(() => startCount(env, 'decision-extractor') === 1)
  await stop(turnStopping({ id: 'sess-b' }))
  await sleep(400)
  assert.equal(maxConcurrency(env, 'decision-extractor'), 1, 'never more than one in-flight run')
  assert.equal(startCount(env, 'decision-extractor'), 1, 'the over-cap run is dropped when coalesce is false')
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

test('coalesce true runs exactly one extra time after an in-flight run', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '150'
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 1 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  await stop(turnStopping(SESSION))
  await waitFor(() => startCount(env, 'decision-extractor') === 1)
  await stop(turnStopping(SESSION))
  await stop(turnStopping(SESSION))
  await waitFor(() => startCount(env, 'decision-extractor') === 2, 3000)
  await sleep(400)
  assert.equal(startCount(env, 'decision-extractor'), 2, 'exactly one coalesced follow-up run')
  assert.equal(maxConcurrency(env, 'decision-extractor'), 1)
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

// ---- L1 (round 12): a session blocked by the global cap keeps its coalesced
//      follow-up and runs it as soon as a slot frees (cross-session drain) ----
test('L1: a session blocked by the cap runs its coalesced follow-up when a slot frees', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '300'
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 1 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  await stop(turnStopping({ id: 'sess-a' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-a') === 1)
  await stop(turnStopping({ id: 'sess-b' }))
  await stop(turnStopping({ id: 'sess-b' }))
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 0, 'B is blocked while A runs')
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-b') === 1, 4000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 1, "B's coalesced follow-up ran exactly once")
  await sleep(500)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 1, 'no double run for B')
  assert.equal(maxConcurrency(env, 'decision-extractor'), 1, 'the cap still holds')
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

// ---- round 13 (FIX 1): the drain must never discard an entry it cannot start.
//      The L1 drain shifted an entry off the queue and dropped it when its own
//      session was still in flight, so a session's OWN coalesced follow-up was
//      lost as soon as any foreign run finished first ----
test('R13: an own coalesced follow-up survives a foreign run finishing first (cap 2)', async () => {
  const env = setup()
  // R14 timing: the run must outlast the start gap by a wide margin. The binding
  // condition is (observation + gap) < delay - the spawn latency cancels out - so
  // a 1000 ms run against a 250 ms gap leaves ~700 ms for a loaded host, where
  // the old 400/100 pair left the ordering to a ~200 ms budget.
  process.env.DSH_TEST_DELAY = '1000'
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 2 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  // Y starts first, so Y finishes first - while X (whose OWN follow-up is queued)
  // is still in flight. That is the drain that used to drop X's entry.
  await stop(turnStopping({ id: 'sess-y' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-y') === 1, 5000)
  await sleep(250)
  await stop(turnStopping({ id: 'sess-x' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-x') === 1, 5000)
  await stop(turnStopping({ id: 'sess-x' }))
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-x'), 1, 'X is coalesced behind its own in-flight run')
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-x') === 2, 8000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-x'), 2, "X's own coalesced follow-up ran exactly once after its run finished")
  await sleep(1300)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-x'), 2, 'no double run for X')
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-y'), 1, 'Y ran exactly once')
  assert.ok(maxConcurrency(env, 'decision-extractor') <= 2, 'the cap still holds')
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

test('R13: three interleaved sessions neither lose nor double-run their coalesced follow-ups (cap 2)', async () => {
  const env = setup()
  // R14 timing: same widening as the R13 cap-2 test above (1000 ms runs, 200 ms
  // gap) so all three session starts are unambiguous on a loaded host.
  process.env.DSH_TEST_DELAY = '1000'
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 2 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  await stop(turnStopping({ id: 'sess-b' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-b') === 1, 5000)
  await sleep(200)
  await stop(turnStopping({ id: 'sess-a' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-a') === 1, 5000)
  await stop(turnStopping({ id: 'sess-a' })) // A's own follow-up, queued while A runs
  await stop(turnStopping({ id: 'sess-b' })) // B's own follow-up, queued while B runs
  await stop(turnStopping({ id: 'sess-c' })) // C never ran: blocked by the cap
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-c'), 0, 'C waits behind the cap')
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-c') === 1, 10000)
  await sleep(1300)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-a'), 2, "A's own follow-up ran exactly once (no lost entry)")
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 2, "B's own follow-up ran exactly once")
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-c'), 1, 'the blocked session ran exactly once')
  assert.ok(maxConcurrency(env, 'decision-extractor') <= 2, 'the cap holds throughout')
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

// ---- Trivial hardening 1 (round 14): a throw inside a drain pass must not lose
//      the entries already spliced out of the queue. Every call in the pass is
//      guarded today, so the throw is injected through a session whose
//      transcript path cannot be resolved (its id throws as it is stringified:
//      the guarded writerFor swallows that, pathFor's own fallback does not).
//      The entries queued BEHIND it must still run. ----
test('R14: a throw inside a drain pass restores the queued remainder instead of losing it', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '600'
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 2 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  let armed = false
  const hostileId = { toString() { if (armed) throw new Error('state accessor boom'); return 'sess-hostile' } }
  await stop(turnStopping({ id: 'sess-p' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-p') === 1)
  await stop(turnStopping({ id: 'sess-q' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-q') === 1)
  // Both slots are busy: the next three sessions can only be queued, in order.
  await stop(turnStopping({ id: hostileId }))
  await stop(turnStopping({ id: 'sess-r1' }))
  await stop(turnStopping({ id: 'sess-r2' }))
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-r1'), 0, 'r1 waits behind the cap')
  armed = true // the hostile session's path lookup now throws inside the drain pass
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-r1') === 1, 8000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-r1'), 1, 'the entry queued behind the throwing one still ran')
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-r2') === 1, 8000)
  await sleep(900)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-r1'), 1, 'r1 ran exactly once')
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-r2'), 1, 'r2 ran exactly once')
  assert.ok(logs.some((line) => /^warn /.test(line) && /coalesced extraction drain failed/.test(line)), 'the drain failure is logged: ' + JSON.stringify(logs))
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})


// ---- L2 (round 12): one guarded rotation sweep runs at activation, not only
//      on the sweepIntervalHours timer ----
test('L2: an aged transcript dir is pruned by one sweep at activation', async () => {
  const env = setup()
  const aged = join(env.root, 'sess-aged')
  mkdirSync(aged, { recursive: true })
  writeFileSync(join(aged, 'transcript.jsonl'), '{"type":"message"}' + LF)
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  utimesSync(join(aged, 'transcript.jsonl'), old, old)
  utimesSync(aged, old, old)
  const { ctx, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { transcript: { dir: env.root, rotation: { enabled: true, maxAgeDays: 1, sweepIntervalHours: 24 } } }))
  assert.equal(existsSync(aged), false, 'the aged session dir was pruned at activation')
  assert.ok(logs.some((line) => /rotation sweep complete/.test(line)), 'the activation sweep logged: ' + JSON.stringify(logs))
  rmSync(env.root, { recursive: true, force: true })
})

// ---- L4 (round 12): a composition with no jobs service is no longer silent;
//      a registry that throws keeps the round-8 warn-once diagnostic ----
test('L4: no jobs service announces the guarded detached promise once at debug', async () => {
  const env = setup()
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  for (let turn = 0; turn < 2; turn += 1) { await stop(turnStopping(SESSION)); await sleep(200) }
  const absent = logs.filter((line) => /job registry absent/.test(line))
  assert.equal(absent.length, 1, 'exactly one note per plugin instance: ' + JSON.stringify(logs.filter((line) => /job registry/.test(line))))
  assert.match(absent[0], /^debug /, 'the note is debug-level: ' + absent[0])
  assert.match(absent[0], /guarded detached/, 'the note names the fallback used: ' + absent[0])
  assert.equal(logs.filter((line) => /^warn /.test(line) && /job registry/.test(line)).length, 0, 'absence is not a warning')
  assert.equal(startCount(env, 'decision-extractor'), 2, 'the guarded fallback still ran both extractions')
  rmSync(env.root, { recursive: true, force: true })
})

test('L4: with no jobs service nothing is emitted at warn level', async () => {
  const env = setup()
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { logging: { level: 'warn' } }))
  await handlers.get('agent/turn-stopping')[0].fn(turnStopping(SESSION))
  await sleep(200)
  assert.equal(logs.filter((line) => /job registry/.test(line)).length, 0, 'silent at warn level: ' + JSON.stringify(logs))
  assert.equal(startCount(env, 'decision-extractor'), 1)
  rmSync(env.root, { recursive: true, force: true })
})

test('L4: a throwing jobs registry keeps the round-8 warn-once and emits no absent note', async () => {
  const env = setup()
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, throwingJobs())
  apply(ctx, baseConfig(env))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  for (let turn = 0; turn < 2; turn += 1) { await stop(turnStopping(SESSION)); await sleep(200) }
  assert.equal(logs.filter((line) => /job registry absent/.test(line)).length, 0, 'no absent note when a registry exists')
  assert.equal(logs.filter((line) => /^warn /.test(line) && /job registry unavailable/.test(line)).length, 1, 'the round-8 warn-once is intact')
  rmSync(env.root, { recursive: true, force: true })
})

test('forceBeforeCompaction bypasses minIntervalMs for the next turn after the gate fires', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 600000, minNewMessages: 0, coalesce: false, maxConcurrentJobs: 1, forceBeforeCompaction: true } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  await stop(turnStopping(SESSION))
  await waitFor(() => startCount(env, 'decision-extractor') === 1)
  assert.equal(startCount(env, 'decision-extractor'), 1, 'first turn runs')
  await stop(turnStopping(SESSION))
  await sleep(150)
  assert.equal(startCount(env, 'decision-extractor'), 1, 'throttled by minIntervalMs')
  await handlers.get('agent/pre-step')[0].fn({ agent: { session: SESSION }, messages: [], turn: 1, step: 1 }, enter)
  assert.equal(startCount(env, 'precompact-extract'), 1, 'the pressure gate fired')
  await stop(turnStopping(SESSION))
  await waitFor(() => startCount(env, 'decision-extractor') === 2)
  assert.equal(startCount(env, 'decision-extractor'), 2, 'the gate bypasses the throttle')
  await sleep(200)
  rmSync(env.root, { recursive: true, force: true })
})

test('forceBeforeCompaction false keeps the throttle after the gate fires', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 600000, minNewMessages: 0, coalesce: false, maxConcurrentJobs: 1, forceBeforeCompaction: false } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  await stop(turnStopping(SESSION))
  await waitFor(() => startCount(env, 'decision-extractor') === 1)
  await handlers.get('agent/pre-step')[0].fn({ agent: { session: SESSION }, messages: [], turn: 1, step: 1 }, enter)
  await stop(turnStopping(SESSION))
  await sleep(200)
  assert.equal(startCount(env, 'decision-extractor'), 1, 'still throttled')
  await sleep(200)
  rmSync(env.root, { recursive: true, force: true })
})

test('ctx.get("jobs") registry receives the detached extraction run', async () => {
  const env = setup()
  const submitted = []
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, {
    get: (serviceName) => serviceName === 'jobs' ? {
      start(spec) { submitted.push(spec); return 'clawmem-extraction-1' },
    } : undefined,
  })
  apply(ctx, baseConfig(env))
  await handlers.get('agent/turn-stopping')[0].fn(turnStopping(SESSION))
  assert.equal(submitted.length, 1, 'the run was submitted to ctx.jobs')
  const spec = submitted[0]
  assert.equal(typeof spec.kind, 'string')
  assert.ok(spec.kind.length > 0)
  assert.equal(typeof spec.label, 'string')
  assert.equal(typeof spec.run, 'function')
  const hooks = spec.run()
  assert.equal(typeof hooks.cancel, 'function')
  assert.ok(hooks.done && typeof hooks.done.then === 'function')
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.equal(startCount(env, 'decision-extractor'), 1, 'the submitted run actually extracted')
  rmSync(env.root, { recursive: true, force: true })
})

test('a throwing job registry falls back to the guarded promise path', async () => {
  const env = setup()
  unhandled.length = 0
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, {
    get: (serviceName) => serviceName === 'jobs' ? { start() { throw new Error('registry down') } } : undefined,
  })
  apply(ctx, baseConfig(env))
  await handlers.get('agent/turn-stopping')[0].fn(turnStopping(SESSION))
  await sleep(250)
  assert.equal(startCount(env, 'decision-extractor'), 1, 'the fallback still ran the extraction')
  assert.deepEqual(unhandled, [])
  rmSync(env.root, { recursive: true, force: true })
})

// ---- round 8: the job-registry warning is quiet after the first occurrence ----

/** A ctx.get('jobs') registry whose every start() throws. */
const throwingJobs = () => ({
  get: (serviceName) => serviceName === 'jobs' ? { start() { throw new Error('registry down') } } : undefined,
})
const registryLinesOf = (logs) => logs.filter((line) => /job registry unavailable/.test(line))

test('a permanently unavailable job registry warns exactly once per plugin instance (round 8)', async () => {
  const env = setup()
  unhandled.length = 0
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, throwingJobs())
  apply(ctx, baseConfig(env))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  for (let turn = 0; turn < 3; turn += 1) {
    await stop(turnStopping(SESSION))
    await sleep(200)
  }
  const registryLines = registryLinesOf(logs)
  const warns = registryLines.filter((line) => /^warn /.test(line))
  assert.equal(warns.length, 1, 'exactly one warn for repeated failures: ' + JSON.stringify(registryLines))
  assert.match(warns[0], /^warn dsh-clawmem: job registry unavailable for clawmem-extract sess-extract: registry down$/,
    'the live-diagnosis message shape is unchanged: ' + JSON.stringify(warns[0]))
  assert.equal(startCount(env, 'decision-extractor'), 3,
    'every attempt still extracted through the guarded fallback')
  assert.deepEqual(unhandled, [], 'no unhandled rejection escapes')
  rmSync(env.root, { recursive: true, force: true })
})

test('later job-registry failures drop to debug and are suppressed at warn level (round 8)', async () => {
  const env = setup()
  unhandled.length = 0
  const debugCtx = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, throwingJobs())
  apply(debugCtx.ctx, baseConfig(env))
  const debugStop = debugCtx.handlers.get('agent/turn-stopping')[0].fn
  for (let turn = 0; turn < 2; turn += 1) {
    await debugStop(turnStopping(SESSION))
    await sleep(200)
  }
  const debugLines = registryLinesOf(debugCtx.logs)
  assert.equal(debugLines.filter((line) => /^warn /.test(line)).length, 1, JSON.stringify(debugLines))
  assert.equal(debugLines.filter((line) => /^debug /.test(line)).length, 1,
    'the repeat failure is logged at debug: ' + JSON.stringify(debugLines))

  const warnEnv = setup()
  const warnCtx = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, throwingJobs())
  apply(warnCtx.ctx, baseConfig(warnEnv, { logging: { level: 'warn' } }))
  const warnStop = warnCtx.handlers.get('agent/turn-stopping')[0].fn
  for (let turn = 0; turn < 2; turn += 1) {
    await warnStop(turnStopping(SESSION))
    await sleep(200)
  }
  const warnLines = registryLinesOf(warnCtx.logs)
  assert.equal(warnLines.length, 1, 'only the first failure is visible at level warn: ' + JSON.stringify(warnLines))
  assert.equal(warnLines.filter((line) => /^debug /.test(line)).length, 0, 'no debug line at level warn')
  assert.deepEqual(unhandled, [])
  rmSync(env.root, { recursive: true, force: true })
  rmSync(warnEnv.root, { recursive: true, force: true })
})

test('a successful job submission clears the warn-once flag so a later failure warns again (round 8)', async () => {
  const env = setup()
  unhandled.length = 0
  let calls = 0
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) }, {
    get: (serviceName) => serviceName === 'jobs' ? {
      start() {
        calls += 1
        if (calls === 3) return 'clawmem-extraction-1'
        throw new Error('registry down')
      },
    } : undefined,
  })
  apply(ctx, baseConfig(env))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  for (let turn = 0; turn < 4; turn += 1) {
    await stop(turnStopping(SESSION))
    await sleep(200)
  }
  assert.equal(calls, 4, 'four extraction attempts reached the registry')
  const registryLines = registryLinesOf(logs)
  assert.equal(registryLines.filter((line) => /^warn /.test(line)).length, 2,
    'a failure after a recovery warns again: ' + JSON.stringify(registryLines))
  assert.equal(registryLines.filter((line) => /^debug /.test(line)).length, 1, JSON.stringify(registryLines))
  assert.deepEqual(unhandled, [])
  rmSync(env.root, { recursive: true, force: true })
})

test('listeners, the sweep interval and transcripts.close() are effect-scoped (M3)', async () => {
  const env = setup()
  const { ctx, handlers, logs, effects, registered } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  const dispose = apply(ctx, baseConfig(env, { transcript: { dir: env.root, rotation: { enabled: true, sweepIntervalHours: 24 } } }))
  for (const event of ['session/event', 'agent/session-start', 'agent/pre-step', 'agent/turn-stopping']) {
    assert.ok(effects.some((label) => String(label).includes(event)), 'effect registered for ' + event + ': ' + JSON.stringify(effects))
  }
  assert.ok(effects.some((label) => String(label).includes('rotation')), 'effect registered for the sweep interval: ' + JSON.stringify(effects))
  assert.equal(typeof dispose, 'function', 'apply returns a disposer')
  dispose()
  assert.equal((handlers.get('session/event') || []).length, 0, 'listeners removed on disposal')
  assert.ok(logs.includes('debug transcript: manager closed') || logs.some((line) => /manager closed/.test(line)), 'transcripts.close() ran: ' + JSON.stringify(logs))
  assert.ok(registered.disposers.length > 0)
  rmSync(env.root, { recursive: true, force: true })
})

test('without ctx.effect apply still returns working disposers', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  delete ctx.effect
  const dispose = apply(ctx, baseConfig(env))
  assert.equal(typeof dispose, 'function')
  assert.ok((handlers.get('session/event') || []).length === 1)
  dispose()
  assert.equal((handlers.get('session/event') || []).length, 0)
  rmSync(env.root, { recursive: true, force: true })
})

// ---- F1 / F7a / F7b (round 2): runtime logging contracts ----

const quietConfig = (env, extra) => baseConfig(env, Object.assign({
  surfacing: { enabled: false },
  precompact: { enabled: false },
  postcompact: { enabled: false },
  extraction: { enabled: false, minIntervalMs: 0, minNewMessages: 0 },
}, extra || {}))

test('one hook failure produces exactly one visible warn/error line, reason kept at debug (F1)', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '5000'
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, {
    surfacing: { enabled: true, minPromptChars: 1, timeoutMs: 120 },
    precompact: { enabled: false },
    postcompact: { enabled: false },
    extraction: { enabled: false, minIntervalMs: 0, minNewMessages: 0 },
  }))
  const result = await handlers.get('agent/pre-step')[0].fn(
    { agent: { session: SESSION }, messages: [{ content: [{ type: 'text', text: 'a prompt that is long enough' }] }], turn: 1, step: 1 },
    enter,
  )
  assert.equal(result.kind, 'enter')
  const hookLines = logs.filter((line) => /context-surfacing/.test(line))
  const visible = hookLines.filter((line) => /^(warn|error) /.test(line))
  const debugs = hookLines.filter((line) => /^debug /.test(line))
  assert.equal(visible.length, 1, 'exactly one visible line per failure: ' + JSON.stringify(hookLines))
  assert.equal(debugs.length, 1, 'the call-site reason stays recoverable at debug: ' + JSON.stringify(hookLines))
  assert.match(debugs[0], /failed \(pre-step\)/)
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

test('a non-zero hook exit produces exactly one visible warn/error line, reason kept at debug (F1)', async () => {
  // Same F1 contract as the timeout test above, but the failing transport result
  // is a non-zero exit (the client logs 'exited code=4' itself, result.logged is
  // true) instead of a timeout. With reportHookFailure reverted to always-warn
  // (the round-2-before shape) this sees 2 visible lines, as the verifier's
  // p-exit.mjs probe did.
  const env = setup()
  process.env.DSH_TEST_FAIL = 'context-surfacing'
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, {
    surfacing: { enabled: true, minPromptChars: 1, timeoutMs: 5000 },
    precompact: { enabled: false },
    postcompact: { enabled: false },
    extraction: { enabled: false, minIntervalMs: 0, minNewMessages: 0 },
  }))
  const result = await handlers.get('agent/pre-step')[0].fn(
    { agent: { session: SESSION }, messages: [{ content: [{ type: 'text', text: 'a prompt that is long enough' }] }], turn: 1, step: 1 },
    enter,
  )
  assert.equal(result.kind, 'enter')
  const hookLines = logs.filter((line) => /context-surfacing/.test(line))
  const visible = hookLines.filter((line) => /^(warn|error) /.test(line))
  const debugs = hookLines.filter((line) => /^debug /.test(line))
  assert.equal(visible.length, 1, 'exactly one visible line per failure: ' + JSON.stringify(hookLines))
  assert.equal(debugs.length, 1, 'the call-site reason stays recoverable at debug: ' + JSON.stringify(hookLines))
  assert.match(debugs[0], /failed \(pre-step\)/)
  assert.match(debugs[0], /exit=4/, 'the transport detail is kept: ' + JSON.stringify(hookLines))
  assert.equal(logLines(env).filter((line) => line === 'start context-surfacing').length, 1, 'the hook really ran and exited non-zero')
  process.env.DSH_TEST_FAIL = ''
  rmSync(env.root, { recursive: true, force: true })
})

test('a downstream next() throw is logged once and still propagates (F7a)', async () => {
  const env = setup()
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, quietConfig(env))
  const handler = handlers.get('agent/pre-step')[0].fn
  await assert.rejects(
    handler({ agent: { session: SESSION }, messages: [], turn: 1, step: 1 }, async () => { throw new Error('downstream boom') }),
    /downstream boom/,
  )
  const witnessed = logs.filter((line) => /^warn /.test(line) && /downstream boom/.test(line))
  assert.equal(witnessed.length, 1, 'the rethrown downstream failure is logged exactly once: ' + JSON.stringify(logs))
  rmSync(env.root, { recursive: true, force: true })
})

test('a throwing lineage accessor is contained, logged at debug and treated as non-subagent (F7b)', () => {
  const env = setup()
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, quietConfig(env))
  const session = new Proxy({ id: 'sess-lineage-throw' }, {
    get(target, prop) { if (prop === 'header') throw new Error('lineage boom'); return target[prop] },
  })
  handlers.get('session/event')[0].fn(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } })
  const debugged = logs.filter((line) => /^debug /.test(line) && /lineage boom/.test(line))
  assert.equal(debugged.length, 1, 'the swallowed lineage error is logged at debug: ' + JSON.stringify(logs))
  assert.ok(existsSync(join(env.root, 'sess-lineage-throw', 'transcript.jsonl')), 'fallback value false keeps the session')
  rmSync(env.root, { recursive: true, force: true })
})

/** A hook bin that records the hook name and the transcript_path it received. */
function writePathProbeBin(dir) {
  const bin = join(dir, 'path-probe.mjs')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    "let body = ''",
    'for await (const chunk of process.stdin) body += chunk',
    "const input = JSON.parse(body || '{}')",
    "appendFileSync(process.env.DSH_PATH_LOG, process.argv[3] + ' ' + String(input.transcript_path) + String.fromCharCode(10))",
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'CTX' } }))",
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  return bin
}

test('a throwing transcripts.pathFor is contained, logged at debug and the default path is used (F7b)', async () => {
  const env = setup()
  const probeBin = writePathProbeBin(env.root)
  const pathLog = join(env.root, 'path.log')
  writeFileSync(pathLog, '')
  process.env.DSH_PATH_LOG = pathLog
  let toStringCalls = 0
  const weirdId = { toString() { toStringCalls += 1; if (toStringCalls <= 2) throw new Error('path boom'); return 'fallback-id' } }
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  apply(ctx, baseConfig(env, {
    clawmemBin: probeBin,
    surfacing: { enabled: false },
    extraction: { enabled: false, minIntervalMs: 0, minNewMessages: 0 },
    precompact: { enabled: true, proximityRatio: 0.8, compactionThresholdRatio: 0.8, fallbackTriggerTokens: 100000, fallbackOnCompactionStart: false, timeoutMs: 5000 },
  }))
  const result = await handlers.get('agent/pre-step')[0].fn({ agent: { session: { id: weirdId } }, messages: [], turn: 1, step: 1 }, enter)
  assert.equal(result.kind, 'enter')
  const debugged = logs.filter((line) => /^debug /.test(line) && /path boom/.test(line))
  assert.equal(debugged.length, 1, 'the swallowed pathFor error is logged at debug: ' + JSON.stringify(logs))
  const recorded = readFileSync(pathLog, 'utf8')
  assert.match(recorded, /^precompact-extract /, 'the hook still ran: ' + JSON.stringify(recorded))
  assert.ok(recorded.includes(join(env.root, 'fallback-id', 'transcript.jsonl')),
    'the documented fallback path reached the hook: ' + JSON.stringify(recorded))
  rmSync(env.root, { recursive: true, force: true })
})

// ---- round 15 (FIX F1, MEDIUM, from the round-14 verifier): the drain must
//      release the slot a throwing entry never actually claimed. pathFor can
//      throw for a non-string session id whose toString throws;
//      scheduleExtraction set state.inFlight / inFlightRuns BEFORE resolving
//      that path, so finish() was never registered: one throw leaked one global
//      slot and TWO throws wedged extraction permanently (the verifier measured
//      {"h1":0,"h2":0,"r1":0,"r2":0,"n1_after_wedge":false}). ----
test('R15/F1: one throw inside a drain pass releases the slot and the entries behind still run', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '500'
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 1 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  let armed = false
  const hostileId = { toString() { if (armed) throw new Error('state accessor boom'); return 'sess-hostile' } }
  await stop(turnStopping({ id: 'sess-a' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-a') === 1, 5000)
  // Cap 1 with A in flight: the next two sessions can only be queued, in order.
  await stop(turnStopping({ id: hostileId }))
  await stop(turnStopping({ id: 'sess-b' }))
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 0, 'b waits behind the cap')
  armed = true // the hostile session's path lookup now throws inside the drain pass
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-b') === 1, 8000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 1, 'the entry queued behind the throwing one still ran')
  // A leaked slot is immediately fatal at cap 1 (the verifier's one-throw run
  // still reported the entries behind running but never released the slot), so a
  // later unrelated extraction starting proves nothing was left claimed.
  await stop(turnStopping({ id: 'sess-c' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-c') === 1, 8000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-c'), 1, 'a later unrelated extraction still starts (no leaked slot)')
  await sleep(700)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 1, 'b ran exactly once')
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-c'), 1, 'c ran exactly once')
  assert.ok(maxConcurrency(env, 'decision-extractor') <= 1, 'the cap still holds')
  assert.ok(logs.some((line) => /^warn /.test(line) && /coalesced extraction drain failed/.test(line)), 'the drain failure is logged: ' + JSON.stringify(logs))
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

test('R15/F1: two throws inside drain passes do not wedge extraction permanently', async () => {
  const env = setup()
  process.env.DSH_TEST_DELAY = '500'
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 0, values: {} }) })
  apply(ctx, baseConfig(env, { extraction: { minIntervalMs: 0, minNewMessages: 0, coalesce: true, maxConcurrentJobs: 1 } }))
  const stop = handlers.get('agent/turn-stopping')[0].fn
  let armed = false
  const hostile = (name) => ({ toString() { if (armed) throw new Error(name + ' boom'); return name } })
  await stop(turnStopping({ id: 'sess-a' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-a') === 1, 5000)
  // Cap 1: two unresolvable entries queue in front of a healthy one.
  await stop(turnStopping({ id: hostile('sess-h1') }))
  await stop(turnStopping({ id: hostile('sess-h2') }))
  await stop(turnStopping({ id: 'sess-b' }))
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 0, 'b waits behind the cap')
  armed = true
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-b') === 1, 8000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 1, 'the entry queued behind both throwing entries still ran')
  // The verifier's wedge metric: after two throws a brand-new session must still
  // extract (n1_after_wedge). Two leaked slots used to exhaust the cap for good.
  await stop(turnStopping({ id: 'sess-n1' }))
  await waitFor(() => startCountFor(env, 'decision-extractor', 'sess-n1') === 1, 8000)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-n1'), 1, 'a new extraction still runs after two throws (no wedge)')
  await sleep(700)
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-b'), 1, 'b ran exactly once')
  assert.equal(startCountFor(env, 'decision-extractor', 'sess-n1'), 1, 'n1 ran exactly once')
  assert.ok(maxConcurrency(env, 'decision-extractor') <= 1, 'the cap still holds')
  const drainWarns = logs.filter((line) => /^warn /.test(line) && /coalesced extraction drain failed/.test(line))
  assert.ok(drainWarns.length >= 2, 'both failures are logged: ' + JSON.stringify(logs))
  process.env.DSH_TEST_DELAY = '0'
  rmSync(env.root, { recursive: true, force: true })
})

// ---- round 15 (F2, LOW, from the round-14 verifier): the empty-transcript-path
//      branch of the L7 guard. ensurePrecompactMemoryDir returns early when
//      transcriptPath is not a non-empty string; the only source of an empty
//      path is the transcript-manager-unavailable stub at index.js:455
//      (pathFor -> ''). That net cannot be reached through config -
//      createTranscriptManager only stores its arguments and spreads the frozen
//      DEFAULT_ROTATION, so nothing in it throws for any resolved config - so
//      this drives the REAL apply()/runPrecompact/ensurePrecompactMemoryDir from
//      a verbatim copy of lib/ whose transcript.js throws at construction (the
//      same fault injection the round-14 verifier used for its revert evidence).
//      dirname('') is '.', so without the guard mkdir would create ./memory in
//      the process CWD: the test chdirs into its own scratch dir to keep that
//      hermetic. ----
test('F2/L7: an empty transcript path creates no memory dir, warns nothing and still attempts the hook', async () => {
  const env = setup()
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
  const copy = join(env.root, 'plugin-copy')
  cpSync(join(pluginRoot, 'lib'), join(copy, 'lib'), { recursive: true })
  const transcriptCopy = join(copy, 'lib', 'transcript.js')
  writeFileSync(transcriptCopy, readFileSync(transcriptCopy, 'utf8')
    .replace('export function createTranscriptManager(', 'function __f2DisabledCreateTranscriptManager(')
    + 'export function createTranscriptManager() { throw new Error("F2 forced transcript manager failure") }' + LF)
  const mod = await import(pathToFileURL(join(copy, 'lib', 'index.js')).href)
  const probeBin = writePathProbeBin(env.root)
  const pathLog = join(env.root, 'path.log')
  writeFileSync(pathLog, '')
  process.env.DSH_PATH_LOG = pathLog
  const { ctx, handlers, logs } = makeCtx({ snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  mod.apply(ctx, {
    clawmemBin: probeBin,
    logging: { level: 'debug' },
    surfacing: { enabled: false },
    skill: { register: false },
    transcript: { dir: join(env.root, 'transcripts'), rotation: { enabled: false } },
    extraction: { enabled: false, minIntervalMs: 0, minNewMessages: 0 },
    precompact: { enabled: true, proximityRatio: 0.8, compactionThresholdRatio: 0.8, fallbackTriggerTokens: 100000, fallbackOnCompactionStart: false, timeoutMs: 5000 },
  })
  assert.ok(logs.some((line) => /^warn /.test(line) && /transcript manager unavailable/.test(line)),
    'the forced failure produced the documented fallback stub: ' + JSON.stringify(logs))
  const cwd = process.cwd()
  process.chdir(env.root)
  let result
  try {
    result = await handlers.get('agent/pre-step')[0].fn({ agent: { session: SESSION }, messages: [], turn: 1, step: 1 }, enter)
  } finally { process.chdir(cwd) }
  assert.equal(result.kind, 'enter')
  // 1. no mkdir for the empty path (the guard's whole point: dirname('') is '.').
  assert.equal(existsSync(join(env.root, 'memory')), false, 'no memory dir was created for the empty transcript path')
  assert.equal(existsSync(join(cwd, 'memory')), false, 'and none in the real CWD either')
  // 2. no warn from the L7 guard.
  assert.equal(logs.filter((line) => /could not create the precompact memory directory/.test(line)).length, 0,
    'the empty path returned before the mkdir/warn: ' + JSON.stringify(logs))
  // 3. the hook was still attempted, with the empty path it was handed.
  const recorded = readFileSync(pathLog, 'utf8').split(LF).filter(Boolean)
  assert.deepEqual(recorded, ['precompact-extract '], 'the hook ran exactly once with the empty transcript_path: ' + JSON.stringify(recorded))
  rmSync(env.root, { recursive: true, force: true })
})
