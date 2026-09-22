// tests/precompact-postcompact.test.mjs
// H5: the gate must read the wire VIEW (snapshot().values.contextPressure),
//     which is the only surface carrying projectedTokens, and fall back to
//     stateOf when snapshot is unavailable.
// M4: postCompactPending clears only when postcompact-inject succeeded.
// M5: the compaction/start fallback runs only if the gate did not already fire.
// L7: dirname(transcript_path)/memory must exist before precompact-extract runs
//     (the hook silently writes nothing when it does not), and a failing mkdir
//     must be logged while the hook is still attempted.
// N2: a raw stateOf fallback that carries a usable contextWindow must be scaled
//     by the window (pressureTokens proxying projectedTokens), never by the
//     absolute fallbackTriggerTokens floor; the debug line must name the branch
//     and the threshold actually used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const LF = String.fromCharCode(10)
const WINDOW = 1000000

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-precompact-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync, existsSync } from 'node:fs'",
    "import { dirname } from 'node:path'",
    'const hook = process.argv[3]',
    "let body = ''",
    'for await (const chunk of process.stdin) body += chunk',
    "if (process.env.DSH_TEST_LOG) appendFileSync(process.env.DSH_TEST_LOG, hook + String.fromCharCode(10))",
    // L7: record the exact JSON the plugin sent on stdin, plus whether
    // dirname(transcript_path)/memory already existed at hook start-up time, so
    // a test can prove the directory was created BEFORE the hook ran.
    "if (process.env.DSH_TEST_STDIN) {",
    '  let memoryDirExists = null',
    "  try { const payload = JSON.parse(body || '{}'); if (payload && payload.transcript_path) memoryDirExists = existsSync(dirname(payload.transcript_path) + '/memory') } catch {}",
    "  appendFileSync(process.env.DSH_TEST_STDIN, JSON.stringify({ hook, body, memoryDirExists }) + String.fromCharCode(10))",
    '}',
    "const fail = (process.env.DSH_TEST_FAIL || '').split(',')",
    'if (fail.includes(hook)) process.exit(3)',
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'CTX-' + hook } }))",
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  const logPath = join(root, 'hooks.log')
  writeFileSync(logPath, '')
  const stdinPath = join(root, 'stdin.log')
  writeFileSync(stdinPath, '')
  process.env.DSH_TEST_LOG = logPath
  process.env.DSH_TEST_STDIN = stdinPath
  process.env.DSH_TEST_FAIL = ''
  return { root, bin, logPath, stdinPath }
}

function spawnCount(env, hook) {
  const text = readFileSync(env.logPath, 'utf8')
  return text.split(LF).filter((line) => line === hook).length
}

/** L7: one { hook, body, memoryDirExists } record per hook spawn. */
function stdinRecords(env, hook) {
  return readFileSync(env.stdinPath, 'utf8').split(LF).filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.hook === hook)
}

function makeCtx(projections) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      error: (m) => logs.push('error ' + m),
      debug: (m) => logs.push('debug ' + m),
    },
    on(event, fn) { const list = handlers.get(event) || []; list.push(fn); handlers.set(event, list); return () => {} },
    skills: { register: () => () => {}, registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    sessionProjections: projections,
    get: () => undefined,
  }
  return { ctx, handlers, logs }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeApply(env, projections, extraConfig) {
  const { ctx, handlers, logs } = makeCtx(projections)
  apply(ctx, Object.assign({
    clawmemBin: env.bin,
    logging: { level: 'debug' },
    surfacing: { enabled: false },
    transcript: { dir: env.root, rotation: { enabled: false } },
  }, extraConfig || {}))
  return { handlers, logs }
}

const SESSION = { id: 'sess-gate' }
const preStep = (session) => ({ agent: { session }, messages: [], turn: 1, step: 1 })
const enter = async () => ({ kind: 'enter', messages: [] })

test('the gate never fires below proximityRatio * compactionThresholdRatio * window', async () => {
  const env = setup()
  const { handlers } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 639999, contextWindow: WINDOW } } }) })
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 0, 'below 0.64 * window')
  rmSync(env.root, { recursive: true, force: true })
})

test('the gate fires at exactly proximityRatio * compactionThresholdRatio * window', async () => {
  const env = setup()
  const { handlers } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'at 0.64 * window')
  rmSync(env.root, { recursive: true, force: true })
})

test('the gate falls back to stateOf and the absolute floor applies when no window is available (N2)', async () => {
  const env = setup()
  const liveState = { surfaceTokens: 123783, pressureTokens: 133474, sampledSurfaceTokens: 121034 }
  const { handlers, logs } = makeApply(env, { stateOf: () => liveState })
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'fallbackTriggerTokens arms via pressureTokens')
  const fired = logs.find((line) => line.startsWith('debug') && /pressure gate fired/.test(line))
  assert.ok(fired, 'the gate logged the branch it took: ' + JSON.stringify(logs))
  assert.match(fired, /branch=stateOf/, 'the branch is named: ' + fired)
  assert.match(fired, /rule=fallbackTriggerTokens/, 'the rule is named: ' + fired)
  assert.match(fired, /threshold=100000/, 'the real threshold is printed: ' + fired)
  rmSync(env.root, { recursive: true, force: true })
})

test('the gate falls back to stateOf when snapshot throws', async () => {
  const env = setup()
  const liveState = { pressureTokens: 133474 }
  const { handlers } = makeApply(env, { snapshot: () => { throw new Error('no cut') }, stateOf: () => liveState })
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1)
  rmSync(env.root, { recursive: true, force: true })
})

// ---- N2: the raw-state fallback must scale by the window, never the floor ----
// snapshot() exists but carries no contextPressure view (values {}) and stateOf
// returns the RAW state: { contextWindow, pressureTokens } with no
// projectedTokens. Owner-approved N2: pressureTokens is the best available proxy
// for the projected value, so the gate compares it against
// proximityRatio * compactionThresholdRatio * contextWindow. The old behaviour
// fired at 13 % of a 1 M window and printed the 640000 threshold it never used.
const rawState = (pressureTokens) => ({ surfaceTokens: 123783, contextWindow: WINDOW, pressureTokens, sampledSurfaceTokens: 121034 })
const snapshotNoView = { snapshot: () => ({ asOfSeq: 1, values: {} }) }

test('N2: the raw-state fallback does NOT fire at 13 percent of a usable window', async () => {
  const env = setup()
  const { handlers, logs } = makeApply(env, Object.assign({}, snapshotNoView, { stateOf: () => rawState(130000) }))
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 0, '130000 < 0.64 * 1000000 -> must not fire')
  const skip = logs.find((line) => line.startsWith('debug') && /pressure gate skip/.test(line))
  assert.ok(skip, 'a skip reason is logged: ' + JSON.stringify(logs))
  assert.match(skip, /branch=stateOf/, 'the debug line names the branch taken: ' + skip)
  assert.match(skip, /threshold=640000/, 'the debug line names the threshold actually used: ' + skip)
  assert.doesNotMatch(skip, /fallbackTriggerTokens/, 'the absolute floor was not used: ' + skip)
  rmSync(env.root, { recursive: true, force: true })
})

test('N2: the raw-state fallback fires at 64 percent of a usable window', async () => {
  const env = setup()
  const { handlers, logs } = makeApply(env, Object.assign({}, snapshotNoView, { stateOf: () => rawState(640000) }))
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, '640000 >= 0.64 * 1000000 -> must fire')
  const fired = logs.find((line) => line.startsWith('debug') && /pressure gate fired/.test(line))
  assert.ok(fired, 'a fire line is logged: ' + JSON.stringify(logs))
  assert.match(fired, /branch=stateOf/, 'the branch is named: ' + fired)
  assert.match(fired, /rule=ratio/, 'the window rule is named: ' + fired)
  assert.match(fired, /threshold=640000/, 'the real threshold is printed: ' + fired)
  rmSync(env.root, { recursive: true, force: true })
})

// ---- FIX 2 (round 13): the two fallbacks compose. snapshot() THROWS and the
// stateOf fallback carries a usable contextWindow, so the window-scaled ratio
// rule must apply with pressureTokens as the proxy. The absolute 100000 floor
// must never be consulted here: 130000 is below 0.64 * 1000000 yet above the
// floor, which is exactly the case the floor-based reading got wrong.
test('N2: a throwing snapshot still scales a windowed stateOf fallback by the window, never the floor', async () => {
  const env = setup()
  const throwingSnapshot = { snapshot: () => { throw new Error('no cut') } }
  const below = makeApply(env, Object.assign({}, throwingSnapshot, { stateOf: () => rawState(130000) }))
  await below.handlers.get('agent/pre-step')[0](preStep({ id: 'sess-throw-below' }), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 0, '130000 < 0.64 * 1000000 and 130000 > 100000 -> the floor must not fire')
  const skip = below.logs.find((line) => line.startsWith('debug') && /pressure gate skip/.test(line))
  assert.ok(skip, 'a skip reason is logged: ' + JSON.stringify(below.logs))
  assert.match(skip, /branch=stateOf/, 'the stateOf branch is named: ' + skip)
  assert.match(skip, /rule=ratio/, 'the window rule is named: ' + skip)
  assert.match(skip, /threshold=640000/, 'the window threshold is used: ' + skip)
  assert.match(skip, /metric=pressureTokens/, 'pressureTokens is the proxy: ' + skip)
  assert.doesNotMatch(skip, /fallbackTriggerTokens/, 'the absolute floor was not used: ' + skip)

  const above = makeApply(env, Object.assign({}, throwingSnapshot, { stateOf: () => rawState(640000) }))
  await above.handlers.get('agent/pre-step')[0](preStep({ id: 'sess-throw-above' }), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, '640000 >= 0.64 * 1000000 -> fires')
  const fired = above.logs.find((line) => line.startsWith('debug') && /pressure gate fired/.test(line))
  assert.ok(fired, 'a fire line is logged: ' + JSON.stringify(above.logs))
  assert.match(fired, /branch=stateOf/, 'the branch is named: ' + fired)
  assert.match(fired, /rule=ratio/, 'the window rule is named: ' + fired)
  assert.match(fired, /metric=pressureTokens/, 'pressureTokens is the proxy: ' + fired)
  rmSync(env.root, { recursive: true, force: true })
})

test('the gate logs a debug reason for a skip (below threshold) and for no pressure', async () => {
  const env = setup()
  const below = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 10, contextWindow: WINDOW } } }) })
  await below.handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.ok(below.logs.some((line) => line.startsWith('debug') && /pressure/i.test(line) && /below/i.test(line)), 'below-threshold reason: ' + JSON.stringify(below.logs))

  const missing = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: {} }) })
  await missing.handlers.get('agent/pre-step')[0](preStep({ id: 'sess-none' }), enter)
  const noPressure = missing.logs.find((line) => line.startsWith('debug') && /pressure/i.test(line) && /no pressure/i.test(line))
  assert.ok(noPressure, 'no-pressure reason: ' + JSON.stringify(missing.logs))
  // FIX 3 (round 13): the no-metric line must name the branch and the rule and
  // must say that neither a metric nor a threshold exists - the old text
  // ("branch=none no pressure") named no rule and hid the missing threshold.
  assert.match(noPressure, /branch=none/, 'the branch is named: ' + noPressure)
  assert.match(noPressure, /rule=none/, 'the rule is named: ' + noPressure)
  assert.match(noPressure, /no pressure metric/, 'the missing metric is stated: ' + noPressure)
  assert.match(noPressure, /no threshold/, 'the missing threshold is stated: ' + noPressure)
  rmSync(env.root, { recursive: true, force: true })
})

test('the gate logs the winning threshold when it fires', async () => {
  const env = setup()
  const { handlers, logs } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.ok(logs.some((line) => line.startsWith('debug') && /gate fired/i.test(line) && /640000/.test(line)))
  rmSync(env.root, { recursive: true, force: true })
})

test('postCompactPending survives a failed postcompact-inject and clears only on success', async () => {
  const env = setup()
  const { handlers } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 0, contextWindow: WINDOW } } }) })
  handlers.get('session/event')[0](SESSION, { type: 'compaction/end', data: {} })
  process.env.DSH_TEST_FAIL = 'postcompact-inject'
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'postcompact-inject'), 1, 'first attempt runs')
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'postcompact-inject'), 2, 'pending survived the failure')

  process.env.DSH_TEST_FAIL = ''
  const okRun = await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'postcompact-inject'), 3, 'successful attempt runs')
  assert.equal(okRun.messages.length, 1, 'the authoritative context is injected on success')
  await handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'postcompact-inject'), 3, 'cleared after success')
  rmSync(env.root, { recursive: true, force: true })
})

test('compaction/start fallback runs only when the pressure gate did not fire', async () => {
  const env = setup()
  const gated = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  await gated.handlers.get('agent/pre-step')[0](preStep(SESSION), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'gate fired')
  gated.handlers.get('session/event')[0](SESSION, { type: 'compaction/start', data: {} })
  await sleep(200)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'no duplicate fallback after the gate fired')

  process.env.DSH_TEST_LOG = env.logPath
  const ungated = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 10, contextWindow: WINDOW } } }) })
  await ungated.handlers.get('agent/pre-step')[0](preStep({ id: 'sess-cold' }), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'gate did not fire for sess-cold')
  ungated.handlers.get('session/event')[0]({ id: 'sess-cold' }, { type: 'compaction/start', data: {} })
  await sleep(200)
  assert.equal(spawnCount(env, 'precompact-extract'), 2, 'fallback ran for the session whose gate did not fire')
  rmSync(env.root, { recursive: true, force: true })
})

test('fallbackOnCompactionStart false disables the fallback entirely', async () => {
  const env = setup()
  const { handlers } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 0, contextWindow: WINDOW } } }) }, { precompact: { fallbackOnCompactionStart: false } })
  handlers.get('session/event')[0](SESSION, { type: 'compaction/start', data: {} })
  await sleep(200)
  assert.equal(spawnCount(env, 'precompact-extract'), 0)
  rmSync(env.root, { recursive: true, force: true })
})

// ---- L7 (round 14): the pre-compaction state directory must exist BEFORE the
//      hook runs. clawmem's precompact-extract writes
//      dirname(transcript_path)/memory/precompact-state.md only when that
//      directory already exists (clawmem src/hooks/precompact-extract.ts:29-43);
//      otherwise it writes nothing and logs nothing, so the compaction/start
//      fallback could log "fallback precompact-extract" with no state file. ----
test('L7: the memory dir next to the transcript is created before precompact-extract runs', async () => {
  const env = setup()
  const sessionDir = join(env.root, 'sess-l7-mkdir')
  assert.equal(existsSync(sessionDir), false, 'precondition: the session transcript dir does not exist yet')
  const { handlers } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) })
  await handlers.get('agent/pre-step')[0](preStep({ id: 'sess-l7-mkdir' }), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'the hook ran')
  assert.equal(existsSync(join(sessionDir, 'memory')), true, 'dirname(transcript_path)/memory exists')
  const records = stdinRecords(env, 'precompact-extract')
  assert.equal(records.length, 1, 'one recorded hook payload')
  assert.equal(records[0].memoryDirExists, true, 'the memory dir already existed when the hook started')
  const payload = JSON.parse(records[0].body)
  assert.equal(payload.transcript_path, join(sessionDir, 'transcript.jsonl'), 'the hook received the expected transcript_path')
  rmSync(env.root, { recursive: true, force: true })
})

test('L7: a failing mkdir is logged and the hook is still attempted', async () => {
  const env = setup()
  // A regular file where the transcript dir should be: every mkdir under it
  // fails with ENOTDIR regardless of the process uid.
  const blocked = join(env.root, 'blocked-not-a-dir')
  writeFileSync(blocked, 'x')
  const { handlers, logs } = makeApply(env, { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { projectedTokens: 640000, contextWindow: WINDOW } } }) }, { transcript: { dir: blocked, rotation: { enabled: false } } })
  await handlers.get('agent/pre-step')[0](preStep({ id: 'sess-l7-fail' }), enter)
  assert.equal(spawnCount(env, 'precompact-extract'), 1, 'the hook is still attempted (fail-open)')
  const warnLine = logs.find((line) => /^warn /.test(line) && /could not create the precompact memory directory/.test(line))
  assert.ok(warnLine, 'the mkdir failure was logged: ' + JSON.stringify(logs))
  assert.match(warnLine, /ENOTDIR|not a directory/i, 'the reason is carried: ' + warnLine)
  const records = stdinRecords(env, 'precompact-extract')
  assert.equal(records.length, 1, 'one recorded hook payload')
  assert.equal(records[0].memoryDirExists, false, 'no memory dir could be created under the blocked path')
  assert.equal(JSON.parse(records[0].body).transcript_path, join(blocked, 'sess-l7-fail', 'transcript.jsonl'), 'the hook still received the transcript path')
  rmSync(env.root, { recursive: true, force: true })
})

