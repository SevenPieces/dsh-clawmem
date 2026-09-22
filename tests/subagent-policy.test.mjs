// tests/subagent-policy.test.mjs
// H2: DSH exposes lineage on session.header (packages/core/session/src/index.ts:464,
// built at :992-1002 from creation meta). The durable record carries top-level
// origin/parentSession and no meta field. Every observed shape must be excluded;
// nothing else may be excluded (D-10).
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const LF = String.fromCharCode(10)

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-subagent-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    "if (process.env.DSH_TEST_LOG) appendFileSync(process.env.DSH_TEST_LOG, process.argv[3] + String.fromCharCode(10))",
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'CTX-' + process.argv[3] } }))",
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  const logPath = join(root, 'hooks.log')
  writeFileSync(logPath, '')
  process.env.DSH_TEST_LOG = logPath
  return { root, bin, logPath }
}

function makeCtx() {
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
    sessionProjections: { stateOf: () => undefined, snapshot: () => ({ asOfSeq: 0, values: {} }) },
    get: () => undefined,
  }
  return { ctx, handlers, logs }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function exercise(env, session) {
  const { ctx, handlers, logs } = makeCtx()
  apply(ctx, {
    clawmemBin: env.bin,
    logging: { level: 'debug' },
    extraction: { minIntervalMs: 0, minNewMessages: 0 },
    transcript: { dir: env.root, rotation: { enabled: false } },
  })
  handlers.get('session/event')[0](session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello from this session' }] } })
  const preStep = await handlers.get('agent/pre-step')[0](
    { agent: { session }, messages: [{ content: [{ type: 'text', text: 'please recall the auth decision from memory' }] }], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  handlers.get('agent/session-start')[0]({ agent: { session } })
  await handlers.get('agent/turn-stopping')[0]({ agent: { session } })
  await sleep(250)
  const spawned = readFileSync(env.logPath, 'utf8').trim() === '' ? [] : readFileSync(env.logPath, 'utf8').trim().split(LF)
  const transcript = join(env.root, session.id, 'transcript.jsonl')
  return { preStep, spawned, transcriptExists: existsSync(transcript), logs }
}

const EXCLUDED = [
  ['header.origin', { id: 'child-header-origin', header: { origin: 'subagent' } }],
  ['header.parentSession', { id: 'child-header-parent', header: { parentSession: 'parent-1' } }],
  ['top-level origin', { id: 'child-top-origin', origin: 'subagent' }],
  ['meta.origin (legacy shape)', { id: 'child-meta-origin', meta: { origin: 'subagent' } }],
  ['meta.parentSession (legacy shape)', { id: 'child-meta-parent', meta: { parentSession: 'parent-1' } }],
]

for (const [label, session] of EXCLUDED) {
  test('excluded subagent shape: ' + label, async () => {
    const env = setup()
    const result = await exercise(env, session)
    assert.equal(result.transcriptExists, false, 'no transcript is written')
    assert.equal(result.spawned.length, 0, 'no hook is spawned')
    assert.equal(result.preStep.messages.length, 0, 'nothing is injected into the enter decision')
    assert.ok(result.logs.some((line) => line.startsWith('debug') && /subagent/.test(line)), 'the policy skip is logged at debug')
    rmSync(env.root, { recursive: true, force: true })
  })
}

const INCLUDED = [
  ['plain session', { id: 'sess-plain' }],
  ['unrelated origin', { id: 'sess-other-origin', origin: 'web' }],
  ['unrelated header origin', { id: 'sess-other-header', header: { origin: 'web' } }],
]

for (const [label, session] of INCLUDED) {
  test('included session shape: ' + label, async () => {
    const env = setup()
    const result = await exercise(env, session)
    assert.equal(result.transcriptExists, true, 'transcript is written')
    assert.ok(result.spawned.length > 0, 'hooks are spawned')
    assert.equal(result.preStep.messages.length, 1, 'surfaced context is injected')
    rmSync(env.root, { recursive: true, force: true })
  })
}

test('policy extract/full includes subagent sessions', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, {
    clawmemBin: env.bin,
    subagents: { policy: 'full' },
    extraction: { minIntervalMs: 0, minNewMessages: 0 },
    transcript: { dir: env.root, rotation: { enabled: false } },
  })
  const session = { id: 'child-included', header: { origin: 'subagent' } }
  handlers.get('session/event')[0](session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'child turn' }] } })
  assert.ok(existsSync(join(env.root, 'child-included', 'transcript.jsonl')), 'included by config')
  rmSync(env.root, { recursive: true, force: true })
})
