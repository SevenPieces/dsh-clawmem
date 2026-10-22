// T-ADV6-01: the first pre-step's collected context must survive a downstream rejection.
//
// The pre-step collects the session bootstrap (from the in-flight agent/created hooks)
// and the authoritative post-compaction context, then calls next(). The code used to
// consume both pieces of state BEFORE next() decided: state.bootstrap was cleared as
// soon as it was read and state.postCompactPending was cleared as soon as
// postcompact-inject succeeded. If the downstream step returned {kind:'reject'} the
// injected parts were dropped and the consumed state was gone, so the next entering
// step carried neither the <vault-session> bootstrap nor the post-compaction context.
//
// kind:'reject' is a production kind (the agent loop's archived-session-gate and the
// claude-code hooks adapter both produce it), and README says the bootstrap runs once
// on the startup announcement and the post-compaction context is re-injected. The
// required behaviour: clear the state only after an ENTERING step actually carries the
// parts; a rejected step changes nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../lib/index.js'

const LF = String.fromCharCode(10)
const SERVICE_NAMES = new Set(['systemPrompt', 'skills', 'sessionProjections', 'jobs', 'loader'])
const BOOTSTRAP_TEXT = '<vault-session>BOOTSTRAP-TEXT</vault-session>'
const POSTCOMPACT_TEXT = '<vault-postcompact>POSTCOMPACT-TEXT</vault-postcompact>'

// Same fake ctx contract as apply.test.mjs / bootstrap-race.test.mjs: only the
// services the plugin's exported inject array grants may be read.
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
  const root = mkdtempSync(join(tmpdir(), 'clawmem-prestep-loss-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  const logPath = join(root, 'hooks.log')
  // Each hook returns a distinct context; the bootstrap and post-compaction markers
  // name the state under test so a lost delivery cannot hide behind another part.
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const hook = process.argv[3]',
    'const log = process.env.DSH_TEST_LOG',
    'if (log) appendFileSync(log, hook + String.fromCharCode(10))',
    'const contexts = {',
    "  'session-bootstrap': " + JSON.stringify(BOOTSTRAP_TEXT) + ",",
    "  'curator-nudge': 'CTX-curator-nudge',",
    "  'staleness-check': 'CTX-staleness-check',",
    "  'postcompact-inject': " + JSON.stringify(POSTCOMPACT_TEXT) + ",",
    "  'context-surfacing': 'CTX-context-surfacing',",
    '}',
    "const context = contexts[hook] || ('CTX-' + hook)",
    'process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: context } }))',
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  process.env.DSH_TEST_LOG = logPath
  return { root, bin, logPath }
}

// Only the pre-step state under test is live: surfacing, compaction and extraction
// would spawn their own hooks and add unrelated context.
function applyForPreStep(ctx, env, overrides) {
  return apply(ctx, Object.assign({
    clawmemBin: env.bin,
    surfacing: { enabled: false },
    precompact: { enabled: false },
    extraction: { enabled: false },
    transcript: { dir: env.root, rotation: { enabled: false } },
  }, overrides || {}))
}

const preStep = (handlers, session, step, next) => handlers.get('agent/pre-step')[0].fn(
  { agent: { session }, messages: [{ content: [{ type: 'text', text: 'prompt' }] }], turn: 1, step },
  next,
)

const enter = async () => ({ kind: 'enter', messages: [] })

function injectedText(result) {
  return ((result && result.messages) || [])
    .map((message) => ((message && message.content) || []).map((block) => (block && block.text) || '').join(''))
    .join('')
}

function spawnCount(env, hook) {
  const text = existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8') : ''
  return text.split(LF).filter((line) => line === hook).length
}

test('T-ADV6-01 (a): a rejected first pre-step injects nothing and the bootstrap survives to the next entering step', async () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    const dispose = applyForPreStep(ctx, env, {})
    const session = { id: 'sess-reject-bootstrap', header: {} }
    handlers.get('agent/created')[0].fn({ agent: { session }, source: 'startup' })

    const reject = { kind: 'reject', reason: 'archived session gate' }
    let nextCalls = 0
    const first = await preStep(handlers, session, 1, async () => { nextCalls += 1; return reject })
    assert.equal(nextCalls, 1, 'the downstream step is still consulted')
    assert.equal(first.kind, 'reject', 'the downstream reject decision must be returned')
    assert.equal((first.messages || []).length, 0,
      'a rejected step must not receive injected messages, got ' + JSON.stringify(first.messages))
    assert.equal(injectedText(first).includes('<vault-session>'), false,
      'a rejected step must not receive the bootstrap, got ' + JSON.stringify(injectedText(first)))
    assert.equal(spawnCount(env, 'session-bootstrap'), 1, 'the bootstrap hook runs once')

    // The next entering step must still carry the bootstrap: the reject may not consume it.
    const second = await preStep(handlers, session, 2, enter)
    assert.equal(second.kind, 'enter')
    assert.match(injectedText(second), /<vault-session>BOOTSTRAP-TEXT<\/vault-session>/,
      'the bootstrap must not be lost across a rejected step, got ' + JSON.stringify(injectedText(second)))
    assert.equal(spawnCount(env, 'session-bootstrap'), 1, 'the bootstrap must not be re-spawned on the later step')

    // Delivered now: a third entering step must not repeat it.
    const third = await preStep(handlers, session, 3, enter)
    assert.equal(injectedText(third).includes('<vault-session>'), false,
      'the bootstrap is delivered exactly once, got ' + JSON.stringify(injectedText(third)))
    dispose()
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-ADV6-01 (b): a rejected step keeps the pending post-compaction context for the next entering step', async () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    // Isolate the post-compaction state: no bootstrap hooks are enabled for this session.
    const dispose = applyForPreStep(ctx, env, {
      bootstrap: { sessionBootstrap: false, curatorNudge: false, stalenessCheck: false },
    })
    const session = { id: 'sess-reject-postcompact', header: {} }
    handlers.get('session/event')[0].fn(session, { type: 'compaction/end', data: {} })

    const first = await preStep(handlers, session, 1, async () => ({ kind: 'reject', reason: 'busy' }))
    assert.equal(first.kind, 'reject')
    assert.equal(injectedText(first).includes(POSTCOMPACT_TEXT), false,
      'a rejected step must not receive the post-compaction context, got ' + JSON.stringify(injectedText(first)))
    assert.equal(spawnCount(env, 'postcompact-inject'), 1,
      'the first step still runs the authoritative-context hook')

    // The hook succeeded before the reject, so the flag must NOT have been consumed:
    // the next entering step delivers the context (the hook may run again).
    const second = await preStep(handlers, session, 2, enter)
    assert.equal(second.kind, 'enter')
    assert.match(injectedText(second), /<vault-postcompact>POSTCOMPACT-TEXT<\/vault-postcompact>/,
      'the post-compaction context must not be lost across a rejected step, got ' + JSON.stringify(injectedText(second)))
    const afterDelivery = spawnCount(env, 'postcompact-inject')

    // Delivered now: the pending flag is cleared, so another entering step changes nothing.
    const third = await preStep(handlers, session, 3, enter)
    assert.equal(injectedText(third).includes(POSTCOMPACT_TEXT), false,
      'the post-compaction context is delivered once, got ' + JSON.stringify(injectedText(third)))
    assert.equal(spawnCount(env, 'postcompact-inject'), afterDelivery,
      'no post-compaction hook runs after the pending flag is cleared')
    dispose()
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})
