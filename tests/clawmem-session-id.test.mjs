// tests/clawmem-session-id.test.mjs
// --- O2 (owner: "do O2"): the id handed to ClawMem must be unique per session. ---
// ClawMem names artifacts from sessionId.slice(0, 8)
// (handoff-generator.ts:61, decision-extractor.ts:401,449,681), and every DSH
// main session id starts with "session-" — so every same-day main session
// collapses into handoffs/<date>-session-.md. (Session focus and multi-turn
// surfacing key on the FULL id, so those were already per session.) ClawMem has no id-shape
// contract (nothing tests the prefix, nothing parses the id, the pre/post-compaction
// state location is derived from transcript_path, subagent gating uses
// origin/parentSession), so the plugin strips ONE leading "session-" at the
// ClawMem boundary. The transcript DIRECTORY and transcript_path keep the real
// DSH id (D-8): only the id handed to ClawMem changes.
//
// --- Change 3 (NEW, HIGH): postcompact-inject must also receive transcript_path. ---
// postcompact-inject.ts:36-46 derives the state directory from
// dirname(transcript_path)/memory. Our plugin sent only { session_id }, so
// getAutoMemoryDir(undefined) fell back to a CWD-derived ~/.claude path that does
// not exist for DSH and Section 1 (the authoritative pre-compaction state) was
// silently never injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const { apply, clawmemSessionId } = plugin

const LF = String.fromCharCode(10)
const DSH_ID = 'session-aaaa1111-1111-4111-8111-111111111111'
const DERIVED = 'aaaa1111-1111-4111-8111-111111111111'
const SERVICE_NAMES = new Set(['systemPrompt', 'skills', 'sessionProjections', 'jobs', 'loader'])

function makeCtx() {
  const handlers = new Map()
  const registered = { skills: [], sections: [] }
  const logs = { warn: [] }
  const services = {
    skills: { register: (s) => { registered.skills.push(s); return () => {} }, registerProvider: () => {} },
    systemPrompt: { section: (s) => { registered.sections.push(s); return () => {} } },
    sessionProjections: { stateOf: () => ({ projectedTokens: 0, contextWindow: 1000000 }), snapshot: () => ({ asOfSeq: 0, values: {} }) },
  }
  const target = {
    logger: { info: () => {}, warn: (m) => logs.warn.push(m), error: () => {}, debug: () => {} },
    on(n, fn, options) { const list = handlers.get(n) || []; list.push({ fn, options }); handlers.set(n, list); return () => {} },
    get: () => undefined,
    effect(execute) { const disposer = execute(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  for (const name of Object.keys(services)) if (plugin.inject.includes(name)) target[name] = services[name]
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop)
      if (Reflect.has(t, prop)) return Reflect.get(t, prop)
      if (SERVICE_NAMES.has(prop)) throw new Error('cannot get property "' + prop + '" without inject')
      return undefined
    },
  })
  return { ctx, handlers, registered, logs }
}

/** A fake clawmem bin that appends every invocation's parsed stdin to a log. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-sid-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import { appendFileSync, readFileSync } from 'node:fs'",
    'const name = process.argv[3]',
    "let raw = ''",
    "try { raw = readFileSync(0, 'utf8') } catch { raw = '' }",
    'let input = null',
    "try { input = raw ? JSON.parse(raw) : null } catch { input = { __unparsed: raw } }",
    "appendFileSync(process.env.DSH_TEST_STDIN_LOG, JSON.stringify({ name, input }) + String.fromCharCode(10))",
    "if (name === 'context-surfacing') process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'CTX-context-surfacing' } }))",
    'else process.stdout.write(JSON.stringify({ continue: true }))',
    '',
  ].join(LF))
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  const stdinLog = join(root, 'stdin.jsonl')
  process.env.DSH_TEST_STDIN_LOG = stdinLog
  return { root, bin, stdinLog, transcriptDir: join(root, 'transcripts') }
}

function readCalls(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split(LF).filter(Boolean).map((line) => JSON.parse(line))
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + (ms || 8000)
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

test('O2 helper: strips exactly one leading "session-"', () => {
  assert.equal(clawmemSessionId(DSH_ID), DERIVED)
  assert.equal(clawmemSessionId('session-session-abc'), 'session-abc', 'only ONE prefix is stripped')
  assert.equal(clawmemSessionId('session-'), '')
})

test('O2 helper: a bare uuid (and anything without the prefix) is untouched', () => {
  assert.equal(clawmemSessionId('aaaa1111-1111-4111-8111-111111111111'), 'aaaa1111-1111-4111-8111-111111111111')
  assert.equal(clawmemSessionId('ses-abc'), 'ses-abc')
  assert.equal(clawmemSessionId('Session-abc'), 'Session-abc', 'case-sensitive: the DSH prefix is lowercase')
})

test('O2 helper: empty and non-string ids are tolerated (no throw)', () => {
  for (const value of ['', undefined, null, 42, {}, [], Symbol('s')]) {
    assert.equal(clawmemSessionId(value), '', 'id=' + String(value))
  }
})

test('O2 helper: two distinct same-day main sessions get two distinct ClawMem keys', () => {
  const a = clawmemSessionId('session-aaaa1111-1111-4111-8111-111111111111')
  const b = clawmemSessionId('session-bbbb2222-2222-4222-8222-222222222222')
  assert.notEqual(a, b)
  assert.equal(a.slice(0, 8), 'aaaa1111')
  assert.equal(b.slice(0, 8), 'bbbb2222')
  assert.ok(!a.startsWith('session-'), 'the shared prefix is gone')
})

test('O2 end-to-end: every hook invocation carries the same derived id, transcript_path keeps the DSH id', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, {
    clawmemBin: env.bin,
    transcript: { dir: env.transcriptDir, rotation: { enabled: false } },
    extraction: { minIntervalMs: 0, minNewMessages: 0 },
    surfacing: { minPromptChars: 1 },
  })
  const session = { id: DSH_ID, header: {} }
  await handlers.get('agent/session-start')[0].fn({ agent: { session } })
  handlers.get('session/event')[0].fn(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real user input' }] } })
  handlers.get('session/event')[0].fn(session, { type: 'compaction/start', data: {} })
  handlers.get('session/event')[0].fn(session, { type: 'compaction/end', data: {} })
  await handlers.get('agent/pre-step')[0].fn({ agent: { session }, messages: [{ content: [{ type: 'text', text: 'what did we decide about auth?' }] }], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  await handlers.get('agent/turn-stopping')[0].fn({ agent: { session } })
  const ready = await waitFor(() => readCalls(env.stdinLog).length >= 9)
  const calls = readCalls(env.stdinLog)
  const names = calls.map((call) => call.name)
  assert.ok(ready, 'expected >=9 hook invocations, saw ' + JSON.stringify(names))
  for (const expected of ['session-bootstrap', 'curator-nudge', 'staleness-check', 'context-surfacing', 'precompact-extract', 'postcompact-inject', 'decision-extractor', 'handoff-generator', 'feedback-loop']) {
    assert.ok(names.includes(expected), 'missing hook ' + expected + ' in ' + JSON.stringify(names))
  }
  for (const call of calls) {
    assert.equal(call.input.session_id, DERIVED, call.name + ' must send the derived id, got ' + JSON.stringify(call.input.session_id))
    assert.ok(!String(call.input.session_id).startsWith('session-'), call.name + ' must not send the raw DSH id')
  }
  // D-8: the transcript path is NOT renamed - it keeps the real DSH id.
  const withPath = calls.filter((call) => typeof call.input.transcript_path === 'string')
  assert.ok(withPath.length >= 5, 'precompact/postcompact/extraction carry transcript_path, got ' + withPath.length)
  for (const call of withPath) {
    assert.ok(call.input.transcript_path.includes(DSH_ID), call.name + ' transcript_path must keep the DSH id: ' + call.input.transcript_path)
  }
  const transcriptPath = join(env.transcriptDir, DSH_ID, 'transcript.jsonl')
  assert.ok(existsSync(transcriptPath), 'the transcript directory keeps the real DSH id (D-8)')
  rmSync(env.root, { recursive: true, force: true })
})

test('Change 3: postcompact-inject receives the SAME transcript_path as precompact-extract (round-trip coherence)', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, {
    clawmemBin: env.bin,
    transcript: { dir: env.transcriptDir, rotation: { enabled: false } },
    extraction: { enabled: false },
    surfacing: { enabled: false },
  })
  const session = { id: DSH_ID, header: {} }
  handlers.get('session/event')[0].fn(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } })
  handlers.get('session/event')[0].fn(session, { type: 'compaction/start', data: {} })
  await waitFor(() => readCalls(env.stdinLog).some((call) => call.name === 'precompact-extract'))
  handlers.get('session/event')[0].fn(session, { type: 'compaction/end', data: {} })
  await handlers.get('agent/pre-step')[0].fn({ agent: { session }, messages: [{ content: [{ type: 'text', text: 'x' }] }], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  await waitFor(() => readCalls(env.stdinLog).some((call) => call.name === 'postcompact-inject'))
  const calls = readCalls(env.stdinLog)
  const pre = calls.find((call) => call.name === 'precompact-extract')
  const post = calls.find((call) => call.name === 'postcompact-inject')
  assert.ok(pre, 'precompact-extract ran: ' + JSON.stringify(calls.map((c) => c.name)))
  assert.ok(post, 'postcompact-inject ran: ' + JSON.stringify(calls.map((c) => c.name)))
  assert.equal(typeof post.input.transcript_path, 'string', 'postcompact-inject must send transcript_path')
  assert.equal(post.input.transcript_path, pre.input.transcript_path, 'the writer path must round-trip')
  assert.equal(post.input.session_id, pre.input.session_id)
  rmSync(env.root, { recursive: true, force: true })
})

// --- Change 3, decisive functional proof with the REAL ClawMem hooks. ---
// postcompact-inject.ts:36-46 + :71 read dirname(transcript_path)/memory/
// precompact-state.md; with only { session_id } (the pre-fix payload) ClawMem
// falls back to a CWD-derived ~/.claude path, finds nothing, and returns an empty
// additionalContext. This test drives the whole round trip through apply() with
// the real bin, INDEX_PATH and CLAWMEM_CONFIG_DIR pinned to a scratch store
// (never the real vault/index), and asserts the state reaches the injected
// context. Skips cleanly when the real bin or bun is unavailable.
const REAL_BIN = process.env.CLAWMEM_REAL_BIN || join(homedir(), '.npm-global/bin/clawmem')
const REAL_BUN = process.env.CLAWMEM_BUN || join(homedir(), '.bun/bin/bun')

test('Change 3 functional proof: the real precompact-extract -> postcompact-inject round trip injects the state', async (t) => {
  if (!existsSync(REAL_BIN)) { t.skip('real clawmem bin not present at ' + REAL_BIN); return }
  if (!existsSync(REAL_BUN) && !existsSync('/usr/bin/env')) { t.skip('bun not present'); return }
  const root = mkdtempSync(join(tmpdir(), 'clawmem-real-'))
  const transcriptDir = join(root, 'transcripts')
  mkdirSync(transcriptDir, { recursive: true })
  const priorIndex = process.env.INDEX_PATH
  const priorConfig = process.env.CLAWMEM_CONFIG_DIR
  process.env.INDEX_PATH = join(root, 'index.sqlite')
  process.env.CLAWMEM_CONFIG_DIR = join(root, 'config')
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, {
      clawmemBin: REAL_BIN,
      transcript: { dir: transcriptDir, rotation: { enabled: false } },
      extraction: { enabled: false },
      surfacing: { enabled: false },
    })
    const session = { id: DSH_ID, header: {} }
    // The marker goes in the last user request: ClawMem's extractor reproduces
    // that verbatim, while a trailing fragment after a decision sentence is
    // trimmed to the sentence.
    const marker = 'ZEBRAFISH-MARKER-7731'
    handlers.get('session/event')[0].fn(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please implement retry in /srv/proj/retry.ts ' + marker }] } })
    handlers.get('session/event')[0].fn(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'We decided to use exponential backoff because the API rate-limits after 10 requests.' }] } } })
    handlers.get('session/event')[0].fn(session, { type: 'compaction/start', data: {} })
    const statePath = join(transcriptDir, DSH_ID, 'memory', 'precompact-state.md')
    const wrote = await waitFor(function () { return existsSync(statePath) && readFileSync(statePath, 'utf8').includes(marker) }, 90000)
    assert.ok(wrote, 'the real precompact-extract must write the session state to ' + statePath)
    handlers.get('session/event')[0].fn(session, { type: 'compaction/end', data: {} })
    const result = await handlers.get('agent/pre-step')[0].fn({ agent: { session }, messages: [{ content: [{ type: 'text', text: 'continue' }] }], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    const injected = (result.messages || []).map((m) => (m.content || []).map((c) => c.text || '').join(LF)).join(LF)
    assert.match(injected, /Pre-Compaction State/, 'the authoritative state must be re-injected, got: ' + injected.slice(0, 300))
    assert.ok(injected.includes(marker), 'the injected context must carry the state content: ' + injected.slice(0, 300))
  } finally {
    if (priorIndex === undefined) delete process.env.INDEX_PATH
    else process.env.INDEX_PATH = priorIndex
    if (priorConfig === undefined) delete process.env.CLAWMEM_CONFIG_DIR
    else process.env.CLAWMEM_CONFIG_DIR = priorConfig
    rmSync(root, { recursive: true, force: true })
  }
})
