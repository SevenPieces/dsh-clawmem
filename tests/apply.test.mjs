import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { createTranscriptManager } from '../lib/transcript.js'

const { apply, inject, userTextOf } = plugin

const LF = String.fromCharCode(10)
const SERVICE_NAMES = new Set(['systemPrompt', 'skills', 'sessionProjections', 'jobs', 'loader'])

// The fake ctx models the Cordis inject requirement: only services granted by
// the plugin's own exported inject array resolve, and any other service read
// throws the error vendor/cordis/src/reflect.ts:144 raises.
function makeCtx(loggerOverride) {
  const handlers = new Map()
  const registered = { skills: [], sections: [] }
  const logs = { warn: [] }
  const services = {
    skills: { register: (s) => { registered.skills.push(s); return () => {} }, registerProvider: () => {} },
    systemPrompt: { section: (s) => { registered.sections.push(s); return () => {} } },
    sessionProjections: { stateOf: () => ({ projectedTokens: 0, contextWindow: 1000000 }), snapshot: () => ({ asOfSeq: 0, values: {} }) },
  }
  const target = {
    logger: loggerOverride || { info: () => {}, warn: (m) => logs.warn.push(m), error: () => {}, debug: () => {} },
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
  return { ctx, handlers, registered, logs }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-apply-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nconst name = process.argv[3]\nif (process.env.DSH_TEST_LOG) appendFileSync(process.env.DSH_TEST_LOG, name + String.fromCharCode(10))\nif (name === 'context-surfacing') process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'CTX-' + name } }))\nelse process.stdout.write(JSON.stringify({ continue: true }))\n")
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  const logPath = join(root, 'hooks.log')
  process.env.DSH_TEST_LOG = logPath
  return { root, bin, logPath }
}

test('apply registers the clawmem skill and the routing section', () => {
  const env = setup()
  const { ctx, registered } = makeCtx()
  const dispose = apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  assert.equal(registered.skills.length, 1)
  assert.equal(registered.skills[0].name, 'clawmem')
  assert.ok(registered.skills[0].content.length > 0)
  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].name, 'clawmem:routing')
  assert.equal(typeof dispose, 'function')
  dispose()
  rmSync(env.root, { recursive: true, force: true })
})

test('session/event appends a transcript line for genuine user input only', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const handler = handlers.get('session/event')[0].fn
  const session = { id: 'sess-a', header: {} }
  handler(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real user input' }] } })
  handler(session, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'agent-instructions' }, content: [{ type: 'text', text: 'injected' }] } })
  const p = join(env.root, 'sess-a', 'transcript.jsonl')
  assert.ok(existsSync(p), 'transcript written')
  const lines = readFileSync(p, 'utf8').trim().split(LF).map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].message.content, 'real user input')
  rmSync(env.root, { recursive: true, force: true })
})

test('agent/pre-step folds surfaced context into the enter decision', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const handler = handlers.get('agent/pre-step')[0].fn
  const payload = { agent: { session: { id: 'sess-b', header: {} } }, messages: [{ content: [{ type: 'text', text: 'please recall the auth decision from memory' }] }], turn: 1, step: 1 }
  const result = await handler(payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].role, 'user')
  assert.match(result.messages[0].content[0].text, /CTX-context-surfacing/)
  rmSync(env.root, { recursive: true, force: true })
})

test('the injected context carries a producer-owned source kind (session format v4)', async () => {
  // A durable v4 message must name its producer; the retired catch-all
  // { kind: 'plugin' } is refused by session-format admission, which aborted
  // every pre-step that carried ClawMem context on dsh 0.2.1.
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const handler = handlers.get('agent/pre-step')[0].fn
  const payload = { agent: { session: { id: 'sess-src', header: {} } }, messages: [{ content: [{ type: 'text', text: 'please recall the auth decision from memory' }] }], turn: 1, step: 1 }
  const result = await handler(payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.messages.length, 1)
  const source = result.messages[0].source
  assert.notEqual(source.kind, 'plugin', 'the catch-all plugin kind is retired in session format v4')
  assert.equal(source.kind, 'plugin:dsh-clawmem')
  assert.equal(source.form, 'snapshot')
  assert.deepEqual(source.sections.map((section) => section.name), ['dsh-clawmem'])
  rmSync(env.root, { recursive: true, force: true })
})

test('subagent sessions are skipped (no skill or transcript side effects)', async () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const session = { id: 'child-1', header: { origin: 'subagent' } }
  handlers.get('session/event')[0].fn(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'child' }] } })
  assert.ok(!existsSync(join(env.root, 'child-1', 'transcript.jsonl')), 'subagent transcript skipped')
  const result = await handlers.get('agent/pre-step')[0].fn({ agent: { session }, messages: [{ content: [{ type: 'text', text: 'please recall the auth decision from memory' }] }], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.messages.length, 0, 'subagent injection skipped')
  rmSync(env.root, { recursive: true, force: true })
})

test('a multi-block tool result emits every block, joined (L5)', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const session = { id: 'sess-tool', header: {} }
  handlers.get('session/event')[0].fn(session, {
    type: 'tool/result',
    data: {
      message: {
        content: [
          { type: 'tool-result', toolCallId: undefined, content: [{ type: 'text', text: 'first block' }] },
          { type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'second block' }] },
          { type: 'tool-result', toolCallId: undefined, content: [{ type: 'text', text: 'third block' }], isError: true },
        ],
      },
    },
  })
  const lines = readFileSync(join(env.root, 'sess-tool', 'transcript.jsonl'), 'utf8').trim().split(LF).map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  const block = lines[0].message.content[0]
  assert.equal(block.tool_use_id, 'call-9', 'toolCallId comes from the first block that has one')
  assert.equal(block.content, ['first block', 'second block', 'third block'].join(LF))
  assert.equal(block.is_error, true, 'any error block marks the result as an error')
  rmSync(env.root, { recursive: true, force: true })
})

test('userTextOf maps real DSH user content blocks (L2)', () => {
  assert.equal(userTextOf('plain'), 'plain')
  assert.equal(userTextOf([{ type: 'text', text: 'hello' }]), 'hello')
  assert.equal(userTextOf([{ type: 'image', attachment: { attachmentId: 'sha256:x', name: 'shot.png', bytes: 5 } }]), '[image]')
  const fileText = userTextOf([{ type: 'file', attachment: { attachmentId: 'sha256:abcdef0123456789', name: 'report.pdf', bytes: 1234 } }])
  assert.match(fileText, /report\.pdf/)
  assert.match(fileText, /1234/)
  assert.equal(userTextOf([{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'result text' }] }]), 'result text')
  assert.equal(userTextOf([{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }, { type: 'text', text: 'b' }]), ['a', '[image]', 'b'].join(LF))
  assert.equal(userTextOf([]), '')
  assert.equal(userTextOf(undefined), '')
})

test('an image-only user turn is still mapped to the [image] placeholder', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  handlers.get('session/event')[0].fn({ id: 'sess-img', header: {} }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:z', name: 'i.png', bytes: 1 } }] },
  })
  const lines = readFileSync(join(env.root, 'sess-img', 'transcript.jsonl'), 'utf8').trim().split(LF).map((l) => JSON.parse(l))
  assert.equal(lines[0].message.content, '[image]')
  rmSync(env.root, { recursive: true, force: true })
})


// --- N-7: ONE path-bearing file-handle format for both writer paths. ---

// The real DSH FileBlock shape (packages/llm/llm/src/types.ts:84-88 wrapping
// packages/attachment/attachment/src/types.ts:39-46 FileAttachmentRef).
const FILE_BLOCK = {
  type: 'file',
  attachment: { attachmentId: 'sha256:' + 'f'.repeat(64), name: 'report.pdf', bytes: 1234 },
}

function readTranscript(root, sessionId) {
  return readFileSync(join(root, sessionId, 'transcript.jsonl'), 'utf8').trim().split(LF).map((l) => JSON.parse(l))
}

test('N-7: the user path and the assistant path emit byte-identical handle text for the same file block', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  // User path: session/event -> userContentOf -> userTextOf.
  handlers.get('session/event')[0].fn({ id: 'sess-handle', header: {} }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [FILE_BLOCK] },
  })
  // Assistant path: transcript manager -> mapBlock -> appendAssistant.
  createTranscriptManager({ dir: env.root }).writerFor('sess-handle').appendAssistant([FILE_BLOCK])
  const lines = readTranscript(env.root, 'sess-handle')
  assert.equal(lines.length, 2)
  const userText = lines[0].message.content
  const assistantText = lines[1].message.content[0].text
  assert.equal(userText, assistantText, 'both paths must use the same handle format')
  assert.match(userText, /name="report\.pdf"/)
  assert.match(userText, /bytes=1234/)
  rmSync(env.root, { recursive: true, force: true })
})

test('N-7: a path-less attachment still yields a non-empty named/sized handle', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const block = { type: 'file', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'plain.md', bytes: 42 } }
  handlers.get('session/event')[0].fn({ id: 'sess-nopath', header: {} }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [block] },
  })
  const text = readTranscript(env.root, 'sess-nopath')[0].message.content
  assert.notEqual(text, '')
  assert.match(text, /name="plain\.md"/)
  assert.match(text, /bytes=42/)
  assert.ok(!text.includes('file_path'), 'no path is invented when the block exposes none')
  assert.equal(text, userTextOf([block]))
  rmSync(env.root, { recursive: true, force: true })
})

test('N-7: an attachment exposing a path yields the {"file_path":"..."} token on the user path', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const block = {
    type: 'file',
    attachment: { attachmentId: 'sha256:' + 'b'.repeat(64), name: 'notes.md', bytes: 42, readonlyPath: '/tmp/objects/notes.md' },
  }
  handlers.get('session/event')[0].fn({ id: 'sess-path', header: {} }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [block] },
  })
  const text = readTranscript(env.root, 'sess-path')[0].message.content
  assert.ok(text.includes('{"file_path":"/tmp/objects/notes.md"}'), text)
  assert.equal(text, userTextOf([block]))
  rmSync(env.root, { recursive: true, force: true })
})

// --- F-3 (LOW, transcript fidelity): a tool result whose inner content is only
// an image or only a file block must not lose its text. ---
const TOOL_FILE_BLOCK = {
  type: 'file',
  attachment: { attachmentId: 'sha256:' + 'c'.repeat(64), name: 'artifact.bin', bytes: 2048 },
}
const TOOL_IMAGE_BLOCK = { type: 'image', attachment: { attachmentId: 'sha256:zz', name: 'shot.png', bytes: 9 } }

function emitToolResult(handlers, session, innerBlocks) {
  handlers.get('session/event')[0].fn(session, {
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-inner', content: innerBlocks }] } },
  })
}

test('F-3: a file-only inner tool-result block keeps its name and byte size', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  emitToolResult(handlers, { id: 'sess-tool-file', header: {} }, [TOOL_FILE_BLOCK])
  const block = readTranscript(env.root, 'sess-tool-file')[0].message.content[0]
  assert.notEqual(block.content, '', 'the handle text must not be lost')
  assert.match(block.content, /name="artifact\.bin"/)
  assert.match(block.content, /bytes=2048/)
  rmSync(env.root, { recursive: true, force: true })
})

test('F-3: an image-only inner tool-result block contributes the [image] placeholder', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  emitToolResult(handlers, { id: 'sess-tool-img', header: {} }, [TOOL_IMAGE_BLOCK])
  const block = readTranscript(env.root, 'sess-tool-img')[0].message.content[0]
  assert.equal(block.content, '[image]')
  rmSync(env.root, { recursive: true, force: true })
})

test('F-3: a mixed inner tool result still concatenates every block in order', () => {
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  emitToolResult(handlers, { id: 'sess-tool-mixed', header: {} }, [
    { type: 'text', text: 'first' },
    TOOL_IMAGE_BLOCK,
    TOOL_FILE_BLOCK,
    { type: 'text', text: 'last' },
  ])
  const block = readTranscript(env.root, 'sess-tool-mixed')[0].message.content[0]
  const parts = block.content.split(LF)
  assert.equal(parts.length, 4, 'every block is emitted: ' + JSON.stringify(block.content))
  assert.equal(parts[0], 'first')
  assert.equal(parts[1], '[image]')
  assert.match(parts[2], /name="artifact\.bin"/)
  assert.match(parts[2], /bytes=2048/)
  assert.equal(parts[3], 'last')
  rmSync(env.root, { recursive: true, force: true })
})

test('F-3 guard: the direct prompt-text path is unchanged for image/file blocks', async () => {
  // textOf() is shared with agent/pre-step (lib/index.js:619). Only tool-result
  // content gains the new mapping, so an image/file-only turn still contributes
  // no prompt text and must not trigger context-surfacing.
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const payload = { agent: { session: { id: 'sess-prompt', header: {} } }, messages: [{ content: [TOOL_IMAGE_BLOCK, TOOL_FILE_BLOCK] }], turn: 1, step: 1 }
  await handlers.get('agent/pre-step')[0].fn(payload, async () => ({ kind: 'enter', messages: [] }))
  const logged = existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8') : ''
  assert.ok(!logged.includes('context-surfacing'), 'image/file blocks are not prompt text: ' + logged)
  rmSync(env.root, { recursive: true, force: true })
})

test('F-3 guard: a tool-result NESTED image/file block is not prompt text either', async () => {
  // The prompt-text traversal must not pick up the tool-result-only mapping.
  // TOOL_FILE_BLOCK's handle text is longer than surfacing.minPromptChars (20),
  // so a leak here would spawn context-surfacing where the pre-fix code did not.
  const env = setup()
  const { ctx, handlers } = makeCtx()
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  const payload = {
    agent: { session: { id: 'sess-prompt-nested', header: {} } },
    messages: [{ content: [{ type: 'tool-result', toolCallId: 'call_nested', content: [TOOL_FILE_BLOCK] }] }],
    turn: 1,
    step: 1,
  }
  await handlers.get('agent/pre-step')[0].fn(payload, async () => ({ kind: 'enter', messages: [] }))
  const logged = existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8') : ''
  assert.ok(!logged.includes('context-surfacing'), 'nested image/file blocks are not prompt text: ' + logged)
  rmSync(env.root, { recursive: true, force: true })
})


// --- N-1 (owner: "do N-1 A"): plugin warn/error lines must reach journald. ---
// This deployment mounts no logger exporter; cordis's built-in exporter is a
// 1000-record ring buffer whose level gate (logger.ts:155-156) defaults to
// INFO=1, so a warn (LoggerLevel.WARN=2) is dropped and nothing reads the buffer.
// apply() therefore registers its own exporter on ctx.logger when that API is
// available, honouring config.logging.level with the plugin's own LOG_RANKS.

/** A cordis-shaped logger: exporter() registers a sink; the severity methods
 *  apply cordis's own gate, "exporter.levels[name] ?? levels.default ?? INFO",
 *  with ERROR=0, INFO=1, WARN=2, DEBUG=3. */
function cordisLogger() {
  const exporters = []
  const logger = {
    exporters,
    exporter(sink) {
      exporters.push(sink)
      return () => { const i = exporters.indexOf(sink); if (i >= 0) exporters.splice(i, 1) }
    },
    _emit(type, level, name, args) {
      for (const sink of exporters.slice()) {
        const levels = sink.levels || {}
        const target = levels[name] !== undefined ? levels[name] : (levels.default !== undefined ? levels.default : 1)
        if (target < level) continue
        sink.export({ sn: 1, ts: Date.now(), name, type, level, args })
      }
    },
    error(...args) { this._emit('error', 0, 'dsh-clawmem', args) },
    warn(...args) { this._emit('warn', 2, 'dsh-clawmem', args) },
    info(...args) { this._emit('info', 1, 'dsh-clawmem', args) },
    debug(...args) { this._emit('debug', 3, 'dsh-clawmem', args) },
    foreign(type, level, name, args) { this._emit(type, level, name, args) },
  }
  return logger
}

/** Capture everything the plugin writes to process.stderr while fn runs. */
function captureStderr(fn) {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function (chunk) { lines.push(String(chunk)); return true }
  try { return { lines, value: fn() } } finally { process.stderr.write = original }
}

function tagsIn(lines) {
  return ['E', 'W', 'I', 'D'].filter((tag) => lines.some((line) => line.includes('MSG-' + tag)))
}

test('N-1: apply() registers a plugin-name-filtered stderr exporter gated by logging.level', () => {
  const env = setup()
  const cases = [
    ['off', []],
    ['error', ['E']],
    ['warn', ['E', 'W']],
    ['debug', ['E', 'W', 'I', 'D']],
  ]
  for (const [level, expected] of cases) {
    const logger = cordisLogger()
    const { ctx } = makeCtx(logger)
    const { lines } = captureStderr(() => {
      const dispose = apply(ctx, { clawmemBin: env.bin, logging: { level: level }, transcript: { dir: env.root, rotation: { enabled: false } } })
      logger.error('MSG-E')
      logger.warn('MSG-W')
      logger.info('MSG-I')
      logger.debug('MSG-D')
      logger.foreign('warn', 2, 'another-plugin', ['MSG-FOREIGN'])
      dispose()
    })
    assert.deepEqual(tagsIn(lines), expected, 'logging.level=' + level + ' lines=' + JSON.stringify(lines))
    assert.ok(!lines.some((line) => line.includes('MSG-FOREIGN')), 'another plugin name must not be written: ' + JSON.stringify(lines))
  }
  rmSync(env.root, { recursive: true, force: true })
})

test('N-1: the emitted line is identifiable and the exporter survives a dispose round trip', () => {
  const env = setup()
  const logger = cordisLogger()
  const { ctx } = makeCtx(logger)
  const { lines, value: dispose } = captureStderr(() => {
    const d = apply(ctx, { clawmemBin: env.bin, logging: { level: 'debug' }, transcript: { dir: env.root, rotation: { enabled: false } } })
    logger.warn('boom warn')
    return d
  })
  assert.equal(logger.exporters.length, 1, 'exactly one exporter is registered')
  assert.ok(lines.some((line) => line.includes('[clawmem][warn] boom warn')), 'identifiable prefix + message: ' + JSON.stringify(lines))
  dispose()
  assert.equal(logger.exporters.length, 0, 'the exporter is removed on unload')
  rmSync(env.root, { recursive: true, force: true })
})

test('N-1: message args are rendered robustly and very long output is truncated', () => {
  const env = setup()
  const logger = cordisLogger()
  const { ctx } = makeCtx(logger)
  const { lines } = captureStderr(() => {
    apply(ctx, { clawmemBin: env.bin, logging: { level: 'debug' }, transcript: { dir: env.root, rotation: { enabled: false } } })
    logger.warn('plain', { a: 1 }, 42, null, undefined)
    logger.warn('long:' + 'x'.repeat(20000))
  })
  assert.ok(lines.some((line) => line.includes('plain') && line.includes('a: 1') && line.includes('42')), 'object/number args are readable: ' + JSON.stringify(lines.slice(0, 4)))
  for (const line of lines) assert.ok(line.length <= 4200, 'one bounded line per message, got ' + line.length)
  rmSync(env.root, { recursive: true, force: true })
})

test('N-1: a logger without an exporter() is not fatal (fail-open)', () => {
  const env = setup()
  const hostile = [
    makeCtx().ctx,
    makeCtx({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, exporter: 'not a function' }).ctx,
    makeCtx({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, exporter: () => { throw new Error('no fiber') } }).ctx,
  ]
  for (const ctx of hostile) {
    let dispose
    const { lines } = captureStderr(() => {
      assert.doesNotThrow(() => { dispose = apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } }) })
    })
    assert.equal(typeof dispose, 'function')
    assert.deepEqual(lines, [], 'no exporter -> nothing is written to stderr')
    assert.doesNotThrow(() => dispose())
  }
  rmSync(env.root, { recursive: true, force: true })
})

test('N-1: a throwing stderr write cannot break the run', () => {
  const env = setup()
  const logger = cordisLogger()
  const { ctx } = makeCtx(logger)
  const dispose = apply(ctx, { clawmemBin: env.bin, logging: { level: 'debug' }, transcript: { dir: env.root, rotation: { enabled: false } } })
  const original = process.stderr.write
  process.stderr.write = function () { throw new Error('stderr is gone') }
  try {
    assert.doesNotThrow(() => logger.warn('MSG-W'), 'a broken stderr must not propagate')
    assert.doesNotThrow(() => logger.error('MSG-E'))
    assert.doesNotThrow(() => dispose())
  } finally {
    process.stderr.write = original
  }
  rmSync(env.root, { recursive: true, force: true })
})


