// T-F2: the session-start bootstrap must be delivered on the FIRST agent/pre-step.
//
// agent/created starts session-bootstrap / curator-nudge / staleness-check in a
// detached IIFE and only stores the joined text in state.bootstrap when every hook
// has finished. The first agent/pre-step used to read state.bootstrap immediately
// and never await in-flight work, so the <vault-session> context landed on the first
// step that happened to run after the hooks finished - or never, for a one-step
// session. The fix must make the first pre-step wait for the in-flight bootstrap
// (exactly once), and must spawn nothing when every bootstrap flag is false.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../lib/index.js'

const LF = String.fromCharCode(10)
const SERVICE_NAMES = new Set(['systemPrompt', 'skills', 'sessionProjections', 'jobs', 'loader'])
// Long enough that "returned immediately" cannot accidentally include the hook, short
// enough to keep the suite quick. The hook itself completes well inside this window.
const BOOTSTRAP_DELAY_MS = 120
const SETTLE_MS = BOOTSTRAP_DELAY_MS + 120

function makeCtx() {
  const handlers = new Map()
  const services = {
    skills: { register: () => () => {}, registerProvider: () => {} },
    systemPrompt: { section: () => () => {} },
    sessionProjections: { stateOf: () => ({ projectedTokens: 0, contextWindow: 1000000 }), snapshot: () => ({ asOfSeq: 0, values: {} }) },
  }
  const target = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on(n, fn, options) { const list = handlers.get(n) || []; list.push({ fn, options }); handlers.set(n, list); return () => {} },
    get: () => undefined,
    effect(execute) { const disposer = execute(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  for (const name of Object.keys(services)) if (inject.includes(name)) target[name] = services[name]
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop)
      if (Reflect.has(t, prop)) return Reflect.get(t, prop)
      if (SERVICE_NAMES.has(prop)) throw new Error('cannot get property "' + prop + '" without inject')
      return undefined
    },
  })
  return { ctx, handlers }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-bootstrap-race-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'slow-bootstrap-clawmem.mjs')
  const logPath = join(root, 'hooks.log')
  // argv = [node, bin, 'hook', <hookName>]. session-bootstrap deliberately takes
  // BOOTSTRAP_DELAY_MS, so a pre-step that does not await cannot see its output.
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const hook = process.argv[3]',
    'const log = process.env.DSH_TEST_LOG',
    'if (log) appendFileSync(log, hook + String.fromCharCode(10))',
    "if (hook === 'session-bootstrap') {",
    '  setTimeout(function () {',
    "    process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: '<vault-session>BOOTSTRAP-TEXT</vault-session>' } }))",
    '  }, ' + BOOTSTRAP_DELAY_MS + ')',
    '} else {',
    "  process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: 'CTX-' + hook } }))",
    '}',
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  process.env.DSH_TEST_LOG = logPath
  return { root, bin, logPath }
}

// Only the bootstrap race is under test: surfacing, compaction and extraction are
// deterministic distractions that would spawn their own hooks.
function applyForRace(ctx, bin, root, bootstrap) {
  return apply(ctx, {
    clawmemBin: bin,
    bootstrap: bootstrap,
    surfacing: { enabled: false },
    precompact: { enabled: false },
    postcompact: { enabled: false },
    extraction: { enabled: false },
    transcript: { dir: root, rotation: { enabled: false } },
  })
}

function preStep(handlers, session, step) {
  return handlers.get('agent/pre-step')[0].fn(
    { agent: { session }, messages: [{ content: [{ type: 'text', text: 'a prompt long enough to surface' }] }], turn: 1, step: step },
    async () => ({ kind: 'enter', messages: [] }),
  )
}

function injectedText(result) {
  return (result.messages || []).map((message) => (message.content || []).map((block) => block.text || '').join('')).join('')
}

function hookLog(logPath) {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').split(LF).filter(Boolean) : []
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('T-F2: the first pre-step receives the in-flight session bootstrap, exactly once', async () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    const dispose = applyForRace(ctx, env.bin, env.root, {})
    const session = { id: 'sess-race', header: {} }
    // Fire agent/created without awaiting (its handler is synchronous and starts the
    // hooks detached), then deliver the first pre-step immediately, as the loop does.
    handlers.get('agent/created')[0].fn({ agent: { session }, source: 'startup' })
    const first = await preStep(handlers, session, 1)
    assert.match(injectedText(first), /<vault-session>BOOTSTRAP-TEXT<\/vault-session>/,
      'the first pre-step must carry the bootstrap, got: ' + JSON.stringify(injectedText(first)))

    // Let any still-detached work land, then prove the text is not delivered again.
    await sleep(SETTLE_MS)
    const second = await preStep(handlers, session, 2)
    assert.equal(injectedText(second).includes('<vault-session>'), false,
      'a later pre-step must not re-inject the bootstrap, got: ' + JSON.stringify(injectedText(second)))
    dispose()
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-F2 control: with every bootstrap flag false nothing is injected and no hook is spawned', async () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    const dispose = applyForRace(ctx, env.bin, env.root, {
      sessionBootstrap: false,
      curatorNudge: false,
      stalenessCheck: false,
    })
    const session = { id: 'sess-no-bootstrap', header: {} }
    handlers.get('agent/created')[0].fn({ agent: { session }, source: 'startup' })
    const first = await preStep(handlers, session, 1)
    assert.equal(injectedText(first), '', 'nothing may be injected when every bootstrap flag is false')
    await sleep(SETTLE_MS)
    const spawned = hookLog(env.logPath)
    const bootstrapHooks = ['session-bootstrap', 'curator-nudge', 'staleness-check']
    assert.deepEqual(spawned.filter((hook) => bootstrapHooks.includes(hook)), [],
      'no bootstrap hook may be spawned, spawned: ' + JSON.stringify(spawned))
    dispose()
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

// --- T-ADV-03: agent/created is not idempotent. ---
// The host may deliver the creation event twice (a non-conforming/older host, or
// a duplicate delivery). Each delivery ran the bootstrap hooks and wrote
// state.bootstrap / state.bootstrapPromise last-writer-wins, so the hooks were
// spawned twice and the bootstrap was either duplicated across two steps or lost
// (nondeterministic). A second creation for a session whose bootstrap is pending
// or already delivered must be a no-op.
//
// The marker file makes exactly ONE session-bootstrap child take the slow path
// (the first to create it), so the second delivery finishes first - the exact
// race from the adversary probe.
function setupDoubleCreate() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-double-created-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'slow-first-clawmem.mjs')
  const logPath = join(root, 'hooks.log')
  const stampPath = join(root, 'first-bootstrap.stamp')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync, writeFileSync } from 'node:fs'",
    'const hook = process.argv[3]',
    'const log = process.env.DSH_TEST_LOG',
    'if (log) appendFileSync(log, hook + String.fromCharCode(10))',
    'let first = false',
    "if (hook === 'session-bootstrap') {",
    '  try {',
    "    writeFileSync(process.env.DSH_TEST_STAMP, 'x', { flag: 'wx' })",
    '    first = true',
    '  } catch { first = false }',
    '}',
    "if (hook === 'session-bootstrap') {",
    '  setTimeout(function () {',
    "    const text = first ? '<vault-session>BOOTSTRAP-FIRST</vault-session>' : '<vault-session>BOOTSTRAP-SECOND</vault-session>'",
    "    process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: text } }))",
    '  }, first ? ' + BOOTSTRAP_DELAY_MS + ' : 0)',
    '} else {',
    "  process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: 'CTX-' + hook } }))",
    '}',
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  process.env.DSH_TEST_LOG = logPath
  process.env.DSH_TEST_STAMP = stampPath
  return { root, bin, logPath }
}

const BOOTSTRAP_HOOKS = ['session-bootstrap', 'curator-nudge', 'staleness-check']

function countOf(text, needle) {
  return text.split(needle).length - 1
}

test('T-ADV-03: a duplicated agent/created spawns the bootstrap hooks once and injects the bootstrap once', async () => {
  const env = setupDoubleCreate()
  try {
    const { ctx, handlers } = makeCtx()
    const dispose = applyForRace(ctx, env.bin, env.root, {})
    const session = { id: 'sess-double-created', header: {} }
    const created = handlers.get('agent/created')[0].fn
    // Two deliveries of the same creation, back to back, before any pre-step: the
    // first session-bootstrap is still in flight when the (fast) second lands.
    created({ agent: { session }, source: 'startup' })
    created({ agent: { session }, source: 'startup' })

    const first = await preStep(handlers, session, 1)
    assert.equal(countOf(injectedText(first), '<vault-session>'), 1,
      'the first pre-step must carry the bootstrap exactly once, got: ' + JSON.stringify(injectedText(first)))

    // Let every still-detached hook land, then prove no second bootstrap is left.
    await sleep(SETTLE_MS)
    const second = await preStep(handlers, session, 2)
    assert.equal(countOf(injectedText(second), '<vault-session>'), 0,
      'a later pre-step must not receive a second bootstrap, got: ' + JSON.stringify(injectedText(second)))

    const spawned = hookLog(env.logPath).filter((hook) => BOOTSTRAP_HOOKS.includes(hook))
    const counts = {}
    for (const hook of spawned) counts[hook] = (counts[hook] || 0) + 1
    assert.deepEqual(counts, { 'session-bootstrap': 1, 'curator-nudge': 1, 'staleness-check': 1 },
      'a repeated creation event must not double-spawn the bootstrap hooks, spawned: ' + JSON.stringify(spawned))
    dispose()
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})
