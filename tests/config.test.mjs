// tests/config.test.mjs
// M6/H4: apply() must be fail-open on a malformed config shape.
// M1: the config values must actually reach the ClawMem client.
// 6.4: every documented key is present with its documented default.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const { apply, clientOptionsFor, createHookClient, resolveConfig, configIssues, unavailableClient } = plugin

const DEFAULT_HOOKS = ['decision-extractor', 'handoff-generator', 'feedback-loop']

function makeCtx() {
  const handlers = new Map()
  const registered = { skills: [], sections: [] }
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      error: (m) => logs.push('error ' + m),
      debug: (m) => logs.push('debug ' + m),
    },
    on(event, fn) { const list = handlers.get(event) || []; list.push(fn); handlers.set(event, list); return () => {} },
    skills: { register: (s) => { registered.skills.push(s); return () => {} }, registerProvider: () => {} },
    systemPrompt: { section: (s) => { registered.sections.push(s); return () => {} } },
    sessionProjections: { stateOf: () => undefined, snapshot: () => ({ asOfSeq: 0, values: {} }) },
    get: () => undefined,
  }
  return { ctx, handlers, registered, logs }
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

test('resolveConfig exposes every documented 6.4 key with its documented default', () => {
  const config = resolveConfig({})
  assert.equal(config.clawmemBin, null, 'auto: resolved at startup, no machine path ships (R-2)')
  assert.equal(config.profile, 'balanced')
  assert.deepEqual({ level: config.logging.level, logHookStderr: config.logging.logHookStderr }, { level: 'warn', logHookStderr: true })
  assert.deepEqual(config.surfacing, { enabled: true, timeoutMs: 2000, minPromptChars: 20 })
  assert.deepEqual(config.bootstrap, { sessionBootstrap: true, curatorNudge: true, stalenessCheck: true })
  assert.equal(config.precompact.enabled, true)
  assert.equal(config.precompact.proximityRatio, 0.8)
  assert.equal(config.precompact.compactionThresholdRatio, 0.8)
  assert.equal(config.precompact.fallbackTriggerTokens, 100000)
  assert.equal(config.precompact.fallbackOnCompactionStart, true)
  assert.equal(config.precompact.timeoutMs, 5000)
  assert.deepEqual(config.postcompact, { enabled: true })
  assert.equal(config.extraction.enabled, true)
  assert.equal(config.extraction.timeoutMs, 30000)
  assert.equal(config.extraction.minIntervalMs, 10000)
  assert.equal(config.extraction.coalesce, true)
  assert.equal(config.extraction.maxConcurrentJobs, 1)
  assert.equal(config.extraction.minNewMessages, 2)
  assert.equal(config.extraction.forceBeforeCompaction, true)
  assert.deepEqual(config.extraction.hooks, DEFAULT_HOOKS)
  assert.deepEqual(config.subagents, { policy: 'exclude' })
  assert.equal(typeof config.transcript.dir, 'string')
  assert.ok(config.transcript.dir.endsWith('clawmem-transcripts'))
  assert.deepEqual(config.transcript.rotation, { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 })
  assert.equal(config.transcript.maxToolResultChars, 500)
  assert.deepEqual(config.skill, { register: true, name: 'clawmem' })
  assert.deepEqual(config.routingBlock, { mode: 'section' })
})

const MALFORMED = [
  ['extraction.hooks string', { extraction: { hooks: 'x' } }],
  ['transcript null', { transcript: null }],
  ['transcript.rotation null', { transcript: { rotation: null } }],
  ['logging.level bogus', { logging: { level: 'bogus' } }],
  ['surfacing.timeoutMs negative', { surfacing: { timeoutMs: -1 } }],
  ['precompact.proximityRatio string', { precompact: { proximityRatio: 'x' } }],
  ['extraction numbers as strings', { extraction: { maxConcurrentJobs: '2', minNewMessages: 'x' } }],
  ['subagents.policy unknown', { subagents: { policy: 'nope' } }],
  ['routingBlock.mode unknown', { routingBlock: { mode: 'weird' } }],
  ['skill.name invalid', { skill: { name: 'Not A Skill' } }],
  ['clawmemBin empty', { clawmemBin: '' }],
  ['null config', null],
  ['string config', 'nonsense'],
]

for (const [label, raw] of MALFORMED) {
  test('resolveConfig repairs malformed config: ' + label, () => {
    let config
    assert.doesNotThrow(() => { config = resolveConfig(raw) })
    assert.ok(isStringArray(config.extraction.hooks), 'hooks stay a non-empty string array')
    assert.equal(typeof config.transcript.dir, 'string')
    assert.ok(config.transcript.rotation && typeof config.transcript.rotation.enabled === 'boolean')
    assert.ok(['off', 'error', 'warn', 'debug'].includes(config.logging.level), 'level is a documented value')
    assert.ok(Number.isFinite(config.surfacing.timeoutMs) && config.surfacing.timeoutMs > 0)
    assert.ok(Number.isFinite(config.precompact.proximityRatio) && config.precompact.proximityRatio > 0)
    assert.ok(Number.isInteger(config.extraction.maxConcurrentJobs) && config.extraction.maxConcurrentJobs >= 1)
    assert.ok(Number.isInteger(config.extraction.minNewMessages) && config.extraction.minNewMessages >= 0)
    assert.ok(['exclude', 'extract', 'full'].includes(config.subagents.policy))
    assert.ok(['section', 'off'].includes(config.routingBlock.mode))
    assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.skill.name))
    assert.ok(config.clawmemBin === null || (typeof config.clawmemBin === 'string' && config.clawmemBin.length > 0), 'auto (null) or an explicit non-empty string')
    assert.ok(typeof config.extraction.coalesce === 'boolean')
    assert.ok(typeof config.extraction.forceBeforeCompaction === 'boolean')
    assert.ok(typeof config.logging.logHookStderr === 'boolean')
    assert.ok(['speed', 'balanced', 'deep'].includes(config.profile))
  })
}

test('malformed shapes are repaired to the documented defaults', () => {
  assert.deepEqual(resolveConfig({ extraction: { hooks: 'x' } }).extraction.hooks, DEFAULT_HOOKS)
  assert.equal(resolveConfig({ logging: { level: 'bogus' } }).logging.level, 'warn')
  assert.equal(resolveConfig({ surfacing: { timeoutMs: -1 } }).surfacing.timeoutMs, 2000)
  assert.equal(resolveConfig({ precompact: { proximityRatio: 'x' } }).precompact.proximityRatio, 0.8)
  assert.deepEqual(resolveConfig({ transcript: null }).transcript.rotation, { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 })
  assert.equal(resolveConfig({ subagents: { policy: 'nope' } }).subagents.policy, 'exclude')
  assert.equal(resolveConfig({ routingBlock: { mode: 'weird' } }).routingBlock.mode, 'section')
  assert.equal(resolveConfig({ skill: { name: 'Not A Skill' } }).skill.name, 'clawmem')
})

test('clientOptionsFor maps the config onto the frozen client options', () => {
  const defaults = clientOptionsFor(resolveConfig({}))
  assert.equal(defaults.bin, null, 'auto is forwarded as null; lib/clawmem.js resolves the chain')
  assert.equal(defaults.level, 'warn')
  assert.equal(defaults.logStderr, true)
  assert.equal(defaults.profile, 'balanced')

  const custom = clientOptionsFor(resolveConfig({ clawmemBin: '/opt/fake-clawmem', profile: 'deep', logging: { level: 'off', logHookStderr: false } }))
  assert.equal(custom.bin, '/opt/fake-clawmem')
  assert.equal(custom.level, 'off')
  assert.equal(custom.logStderr, false)
  assert.equal(custom.profile, 'deep')

  const logger = { warn: () => {} }
  assert.equal(clientOptionsFor(resolveConfig({}), logger).logger, logger, 'the host logger is forwarded')

  const hostile = clientOptionsFor({ profile: 'nope', logging: { level: 'nope', logHookStderr: 'yes' }, clawmemBin: 7 })
  assert.equal(hostile.profile, 'balanced')
  assert.equal(hostile.level, 'warn')
  assert.equal(hostile.logStderr, true)
  assert.equal(hostile.bin, null, 'a non-string clawmemBin is repaired to auto, never to a machine path')
})

// R4 #16: the README documents clawmemBin null as the default, so a user copying it
// must not be told their config was repaired on every boot.
test('R-2: the documented auto default is not reported as a repair', () => {
  assert.deepEqual(configIssues({}), [], 'an absent value is not a repair')
  assert.deepEqual(configIssues({ clawmemBin: null }), [], 'the documented null default is valid, not a repair')
  assert.equal(resolveConfig({ clawmemBin: null }).clawmemBin, null)
  assert.deepEqual(configIssues({ clawmemBin: 7 }), ['clawmemBin is not a non-empty string; using null'], 'a genuinely malformed value still warns')
  // X3 D2: transcript.dir has a documented null default too - and the README shows it - so it
  // must be as quiet as clawmemBin, while a genuinely malformed value still warns once.
  assert.deepEqual(configIssues({ transcript: { dir: null } }), [], 'the documented transcript.dir default is not a repair')
  assert.equal(configIssues({ transcript: { dir: 7 } }).length, 1, 'a malformed transcript.dir still warns')
  assert.equal(resolveConfig({ transcript: { dir: null } }).transcript.dir, join(process.env.DSH_HOME || join(process.env.HOME, '.dsh'), 'clawmem-transcripts'))
})

// R4 #13 prerequisite: apply() resolves the binary once and hands the same value to
// the hook client, so the fallback client and the skill path agree with it.
test('R-2: clientOptionsFor forwards the bin apply() resolved', () => {
  const choice = { bin: '/resolved/clawmem', source: 'home-npm-global' }
  const forwarded = clientOptionsFor(resolveConfig({}), undefined, choice)
  assert.equal(forwarded.bin, '/resolved/clawmem', 'the bin apply() resolved is forwarded')
  assert.equal(forwarded.binSource, 'home-npm-global', 'and its provenance is preserved for the ready line')
  assert.equal(clientOptionsFor(resolveConfig({ clawmemBin: '/explicit/clawmem' }), undefined, choice).bin, '/explicit/clawmem', 'an explicit value still wins')
  assert.equal(clientOptionsFor(resolveConfig({}), undefined).bin, null, 'with nothing resolved it stays null for the client to resolve itself')
})

// R3 #11: when the hook transport cannot be created at all, the stand-in client must
// still carry the resolved binary - otherwise the skill path is skipped silently and the
// plugin loses its skill with no warning beyond the transport failure.
test('R-2: the fallback client keeps the resolved bin so the skill path still runs', () => {
  const stub = unavailableClient({ bin: '/resolved/clawmem', source: 'path' })
  assert.equal(typeof stub.runHook, 'function')
  assert.equal(stub.bin, '/resolved/clawmem')
  assert.equal(stub.binSource, 'fallback')
  assert.equal(unavailableClient(null).bin, null, 'an unresolved choice stays null')
  assert.equal(unavailableClient(undefined).bin, null)
  assert.equal(unavailableClient({ bin: 7 }).bin, null, 'a non-string bin is not forwarded')
})

// V2's gap: the fallback path was only unit-tested through unavailableClient, so reverting
// apply()'s wiring broke no test. createHookClient makes the integration itself testable.
test('R-2: a failing client factory falls back to a client that still carries the bin', () => {
  const choice = { bin: '/resolved/clawmem', source: 'home-npm-global' }
  const boom = () => { throw new Error('FORCED-FACTORY-FAILURE') }
  const failed = createHookClient(resolveConfig({}), undefined, choice, boom)
  assert.equal(failed.error && failed.error.message, 'FORCED-FACTORY-FAILURE', 'the failure is reported, not swallowed')
  assert.equal(typeof failed.client.runHook, 'function')
  assert.equal(failed.client.bin, '/resolved/clawmem', 'the stand-in still carries the resolved binary')
  assert.equal(failed.client.binSource, 'fallback')

  const seen = {}
  const ok = createHookClient(resolveConfig({}), undefined, choice, (opts) => { seen.opts = opts; return { runHook: () => {}, bin: opts.bin, binSource: opts.binSource } })
  assert.equal(ok.error, null)
  assert.equal(ok.client.bin, '/resolved/clawmem', 'the choice reaches the real factory')
  assert.equal(ok.client.binSource, 'home-npm-global', 'with its provenance intact')
})

test('R-2: apply() wires the resolved bin through the client and the skill root (source contract)', () => {
  // A one-line integration cannot be exercised behaviourally without a transport failure, so
  // this pins the wiring itself: a silent revert of either link fails here.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /createHookClient\(config, logger, binChoice\)/, 'apply() must build the client from the resolved choice')
  assert.match(source, /unavailableClient\(binChoice\)/, 'the fallback must receive the resolved choice')
  assert.match(source, /isRegularFile\(binAbsolute\)/, 'the skill root must require a regular file')
})

// Regression tests for the two defects batch 2 fixed: a directory (or a missing path) as clawmemBin
// registered an unrelated parent SKILL.md silently, and a relative-but-real bin lost its skill.
test('R-2: a directory or a missing path as clawmemBin never yields a package root', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-dirbin-'))
  try {
    mkdirSync(join(root, 'pkg', 'bin'), { recursive: true })
    writeFileSync(join(root, 'SKILL.md'), ['---', 'name: clawmem', 'description: DECOY FROM PARENT', '---', 'BODY', ''].join(String.fromCharCode(10)))
    for (const bad of [join(root, 'pkg'), join(root, 'nope', 'clawmem')]) {
      const { ctx, registered, logs } = makeCtx()
      const dispose = apply(ctx, { clawmemBin: bad, transcript: { dir: join(root, 'tx'), rotation: { enabled: false } } })
      assert.equal(registered.skills.length, 0, 'no skill may come from ' + bad)
      assert.ok(logs.some((line) => line.includes('no clawmem binary file resolved')), 'and it must say why: ' + JSON.stringify(logs))
      dispose()
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R-2: a relative but existing clawmemBin still registers the skill from its own package', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-relbin-'))
  const cwd = process.cwd()
  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'clawmem'), '#!/bin/sh' + String.fromCharCode(10) + 'exit 0')
    chmodSync(join(root, 'bin', 'clawmem'), 0o755)
    writeFileSync(join(root, 'SKILL.md'), ['---', 'name: clawmem', 'description: RELATIVE PACKAGE', '---', 'BODY', ''].join(String.fromCharCode(10)))
    process.chdir(root)
    const { ctx, registered } = makeCtx()
    const dispose = apply(ctx, { clawmemBin: './bin/clawmem', transcript: { dir: join(root, 'tx'), rotation: { enabled: false } } })
    assert.equal(registered.skills.length, 1, 'a relative real path is still a package root')
    assert.equal(registered.skills[0].resourceBase.path, root)
    dispose()
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }) }
})

// R3 #12: a bare name is not a path. realpathSync('clawmem') failed, dirname('.')
// became '..', and an unrelated SKILL.md beside the parent of cwd could be registered.
test('R-2: a non-absolute clawmemBin registers no skill and says why', () => {
  const { ctx, registered, logs } = makeCtx()
  const root = mkdtempSync(join(tmpdir(), 'clawmem-skill-'))
  const dispose = apply(ctx, { clawmemBin: 'clawmem', transcript: { dir: root, rotation: { enabled: false } } })
  assert.equal(registered.skills.length, 0, 'a bare name must not resolve a package root')
  assert.ok(logs.some((line) => line.includes('no clawmem binary file resolved')), 'the reason must be specific: ' + JSON.stringify(logs))
  assert.equal(typeof dispose, 'function')
  dispose()
  rmSync(root, { recursive: true, force: true })
})

test('apply() never throws on a malformed config shape (M6)', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-config-'))
  for (const raw of [{ transcript: null }, { transcript: { rotation: null } }, { extraction: { hooks: 'x' } }, null, 'nonsense']) {
    const { ctx } = makeCtx()
    assert.doesNotThrow(() => {
      apply(ctx, Object.assign({ clawmemBin: '/bin/false' }, raw === null || typeof raw === 'string' ? {} : raw))
    })
  }
  const { ctx } = makeCtx()
  assert.doesNotThrow(() => { apply(ctx, { clawmemBin: '/bin/false', transcript: { dir: root, rotation: { enabled: false } } }) })
  rmSync(root, { recursive: true, force: true })
})

// --- F-1 (MEDIUM, observability): a non-record whole SECTION must be repaired loudly. ---
// A YAML `transcript:` with no value parses to null, so every shape below is a real one.
const SECTION_SHAPES = [
  ['transcript null', { transcript: null }, 'transcript'],
  ['transcript string', { transcript: 'x' }, 'transcript'],
  ['transcript empty array', { transcript: [] }, 'transcript'],
  ['logging null', { logging: null }, 'logging'],
  ['logging string', { logging: 'loud' }, 'logging'],
  ['extraction null', { extraction: null }, 'extraction'],
  ['surfacing number', { surfacing: 43 }, 'surfacing'],
  ['bootstrap empty array', { bootstrap: [] }, 'bootstrap'],
  ['skill null', { skill: null }, 'skill'],
  ['precompact null', { precompact: null }, 'precompact'],
  ['postcompact null', { postcompact: null }, 'postcompact'],
  ['subagents null', { subagents: null }, 'subagents'],
  ['routingBlock null', { routingBlock: null }, 'routingBlock'],
  ['raw null', null, 'config'],
]

for (const [label, raw, key] of SECTION_SHAPES) {
  test('F-1: a non-record section is repaired loudly and fails open: ' + label, () => {
    const issues = configIssues(raw)
    assert.equal(issues.length, 1, 'exactly one repair issue for ' + label + ', got ' + JSON.stringify(issues))
    assert.ok(issues[0].includes(key), 'the issue names ' + key + ': ' + issues[0])
    // Fail-open: the malformed section is replaced by the documented defaults.
    assert.deepEqual(resolveConfig(raw), resolveConfig({}), label + ' must fall back to the documented defaults')
  })
}

test('F-1: a fully valid config reports zero repair issues', () => {
  assert.deepEqual(configIssues({}), [], 'the empty config is valid')
  const valid = {
    clawmemBin: '/opt/clawmem',
    profile: 'deep',
    logging: { level: 'debug', logHookStderr: false },
    surfacing: { enabled: false, timeoutMs: 10, minPromptChars: 0 },
    bootstrap: { sessionBootstrap: false, curatorNudge: false, stalenessCheck: false },
    precompact: { enabled: false, proximityRatio: 0.5, compactionThresholdRatio: 0.5, fallbackTriggerTokens: 10, fallbackOnCompactionStart: false, timeoutMs: 20 },
    postcompact: { enabled: false },
    extraction: { enabled: false, timeoutMs: 5, minIntervalMs: 0, coalesce: false, maxConcurrentJobs: 2, minNewMessages: 0, forceBeforeCompaction: false, hooks: ['a-hook', 'b-hook'] },
    subagents: { policy: 'full' },
    transcript: { dir: '/tmp/valid-transcripts', rotation: { enabled: false, maxAgeDays: 1, sweepIntervalHours: 1 }, maxToolResultChars: 0 },
    skill: { register: false, name: 'my-skill' },
    routingBlock: { mode: 'off' },
  }
  assert.deepEqual(configIssues(valid), [], 'every value above is documented-valid')
  assert.deepEqual(resolveConfig(valid).skill, { register: false, name: 'my-skill' })
})

test('F-1: apply() surfaces each repaired section as one warn line', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-issues-'))
  const { ctx, logs } = makeCtx()
  apply(ctx, { clawmemBin: '/bin/false', transcript: { dir: root, rotation: { enabled: false } }, logging: null, surfacing: 43 })
  const repaired = logs.filter((line) => line.includes('config repaired'))
  assert.equal(repaired.length, 2, 'two repaired sections -> two warn lines, got ' + JSON.stringify(repaired))
  assert.ok(repaired.some((line) => line.includes('logging')), 'names logging')
  assert.ok(repaired.some((line) => line.includes('surfacing')), 'names surfacing')
  rmSync(root, { recursive: true, force: true })
})

// --- F-2 (LOW, observability): an invalid skill.name must not be silently coerced. ---
test('F-2: an invalid skill.name is repaired loudly and falls back to clawmem', () => {
  const raw = { skill: { name: 'Not A Skill' } }
  const issues = configIssues(raw)
  assert.equal(issues.length, 1, 'exactly one repair issue, got ' + JSON.stringify(issues))
  assert.ok(issues[0].includes('skill.name'), 'the issue names skill.name: ' + issues[0])
  assert.equal(resolveConfig(raw).skill.name, 'clawmem')

  const numeric = configIssues({ skill: { name: 42 } })
  assert.equal(numeric.length, 1, 'a non-string name is repaired too: ' + JSON.stringify(numeric))
  assert.ok(numeric[0].includes('skill.name'))
  assert.equal(resolveConfig({ skill: { name: 42 } }).skill.name, 'clawmem')

  assert.deepEqual(configIssues({ skill: { name: 'my-skill' } }), [], 'a valid name is not a repair')
  assert.equal(resolveConfig({ skill: { name: 'my-skill' } }).skill.name, 'my-skill')
  assert.deepEqual(configIssues({ skill: {} }), [], 'an absent name is a default, not a repair')
  assert.deepEqual(configIssues({}), [], 'an absent skill section is a default, not a repair')
})

// --- T-ADV3-01 (MEDIUM): a rotation sweep interval above the 32-bit timer
//     maximum was passed to setInterval() unchanged. Node clamps such a delay to
//     1 ms (TimeoutOverflowWarning), turning a monthly/yearly pruning interval
//     into a busy sweep loop. The config repair must clamp it to the largest
//     whole-hour delay the timer accepts: floor((2**31 - 1) / 3600000) = 596 h.
const MAX_SWEEP_HOURS = 596

test('T-ADV3-01: a rotation sweep interval above the timer maximum is repaired to 596 h and reported', () => {
  const repaired = resolveConfig({ transcript: { rotation: { sweepIntervalHours: 720 } } })
  assert.equal(repaired.transcript.rotation.sweepIntervalHours, MAX_SWEEP_HOURS,
    '720 h (2592000000 ms) exceeds the 32-bit timer maximum and must be clamped to 596 h')
  const issues = configIssues({ transcript: { rotation: { sweepIntervalHours: 720 } } })
  assert.equal(issues.length, 1, 'exactly one repair issue, got ' + JSON.stringify(issues))
  assert.ok(issues[0].includes('transcript.rotation.sweepIntervalHours'),
    'the issue names the repaired key: ' + issues[0])

  // The maximum itself is a valid configured value and is not reported.
  assert.equal(resolveConfig({ transcript: { rotation: { sweepIntervalHours: MAX_SWEEP_HOURS } } }).transcript.rotation.sweepIntervalHours, MAX_SWEEP_HOURS)
  assert.deepEqual(configIssues({ transcript: { rotation: { sweepIntervalHours: MAX_SWEEP_HOURS } } }), [],
    '596 h is accepted without a repair issue')

  // The boundary is exact: one hour above the maximum repairs too.
  assert.equal(resolveConfig({ transcript: { rotation: { sweepIntervalHours: 597 } } }).transcript.rotation.sweepIntervalHours, MAX_SWEEP_HOURS,
    '597 h (2149200000 ms) is one hour past the maximum and must be repaired to 596 h')
  const above = configIssues({ transcript: { rotation: { sweepIntervalHours: 597 } } })
  assert.equal(above.length, 1, '597 h is repaired and reported: ' + JSON.stringify(above))
  assert.ok(above[0].includes('transcript.rotation.sweepIntervalHours'), 'the issue names the key: ' + above[0])
})

test('T-ADV3-01: the interval handed to setInterval for a 720 h config is within the platform range', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-rotation-interval-'))
  // Capture the delay without scheduling a real timer: the defect is the value
  // handed to setInterval, and a real overflowing timer would clamp to 1 ms and
  // sweep in a loop.
  const realSetInterval = globalThis.setInterval
  const captured = []
  globalThis.setInterval = function (fn, delay) {
    captured.push(delay)
    return { unref() {}, ref() {} }
  }
  let dispose
  try {
    const { ctx } = makeCtx()
    dispose = apply(ctx, {
      clawmemBin: '/bin/false',
      transcript: { dir: root, rotation: { enabled: true, sweepIntervalHours: 720 } },
    })
  } finally {
    globalThis.setInterval = realSetInterval
  }
  try {
    assert.equal(captured.length, 1, 'rotation registers exactly one interval: ' + JSON.stringify(captured))
    const delay = captured[0]
    assert.ok(delay <= 2147483647,
      'the delay passed to setInterval must fit the 32-bit timer limit, got ' + delay)
    assert.notEqual(delay, 1,
      "an overflowing interval must never reach setInterval as Node's 1 ms clamp")
  } finally {
    if (typeof dispose === 'function') dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

// --- T-ADV3-02 (LOW): the surfacing/precompact/extraction hook timeouts were
//     passed to setTimeout() unclamped for the same reason. A value above
//     2**31 - 1 must repair to the timer maximum, not reach the timer raw.
const MAX_HOOK_TIMEOUT_MS = 2147483647

test('T-ADV3-02: hook timeouts above the 32-bit timer maximum are repaired to 2147483647 ms', () => {
  const cases = [
    ['surfacing', { surfacing: { timeoutMs: 3000000000 } }, 'surfacing.timeoutMs'],
    ['precompact', { precompact: { timeoutMs: 3000000000 } }, 'precompact.timeoutMs'],
    ['extraction', { extraction: { timeoutMs: 3000000000 } }, 'extraction.timeoutMs'],
  ]
  for (const [section, raw, label] of cases) {
    assert.equal(resolveConfig(raw)[section].timeoutMs, MAX_HOOK_TIMEOUT_MS,
      section + '.timeoutMs must be clamped to the 32-bit timer maximum')
    const issues = configIssues(raw)
    assert.equal(issues.length, 1, 'exactly one repair issue for ' + section + ': ' + JSON.stringify(issues))
    assert.ok(issues[0].includes(label), 'the issue names ' + label + ': ' + issues[0])

    // The maximum itself is accepted and is not reported as repaired.
    const atMax = { [section]: { timeoutMs: MAX_HOOK_TIMEOUT_MS } }
    assert.equal(resolveConfig(atMax)[section].timeoutMs, MAX_HOOK_TIMEOUT_MS, label + ' = 2**31-1 is a valid value')
    assert.deepEqual(configIssues(atMax), [], label + ' = 2**31-1 must not be reported as repaired')
  }
})

