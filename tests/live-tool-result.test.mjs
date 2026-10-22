// T-F1: the live DSH session-format-v4 tool/result shape must reach the transcript.
//
// A v4 ToolResultMessage (packages/llm/llm/src/message.ts:173-180,
// createToolResultMessage:299-306) carries the correlation id and the error flag at
// MESSAGE level:
//   { role: 'tool', source: { kind: 'tool', callId }, toolCallId, isError?, content: ContentBlock[] }
// and the agent loop appends it as ('tool/result', { turn, step, message })
// (packages/core/agent-loop/src/tool-calls.ts:268-289). The retired v3 wrapper put
// toolCallId/isError on a nested { type: 'tool-result' } block instead.
//
// The adapter used to read only the retired block shape, so every live result lost
// its tool_use_id, recorded tool errors as success, could not de-duplicate a
// re-delivery, and dropped image/file payloads (they mapped to ''). These tests drive
// the live shape through session/event, plus one replay-compatibility control for the
// legacy block-level shape.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../lib/index.js'
import { createTranscriptManager } from '../lib/transcript.js'

const LF = String.fromCharCode(10)
const SERVICE_NAMES = new Set(['systemPrompt', 'skills', 'sessionProjections', 'jobs', 'loader'])

// The fake ctx models the Cordis inject requirement: only services granted by the
// plugin's own exported inject array resolve, and any other service read throws the
// error vendor/cordis/src/reflect.ts:144 raises (same contract as apply.test.mjs).
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
  const root = mkdtempSync(join(tmpdir(), 'clawmem-live-tool-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, "#!/usr/bin/env node" + LF + "process.stdout.write(JSON.stringify({ continue: true }))" + LF)
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  return { root, bin }
}

function emitToolResult(handlers, session, message) {
  handlers.get('session/event')[0].fn(session, { type: 'tool/result', data: { turn: 1, step: 1, message } })
}

function readTranscript(root, sessionId) {
  const path = join(root, sessionId, 'transcript.jsonl')
  assert.ok(existsSync(path), 'transcript written for ' + sessionId)
  return readFileSync(path, 'utf8').trim().split(LF).filter(Boolean).map((line) => JSON.parse(line))
}

function liveMessage(fields) {
  return Object.assign({ role: 'tool' }, fields)
}

test('T-F1: a live v4 tool/result keeps the message-level toolCallId and isError', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-live', header: {} }, liveMessage({
      source: { kind: 'tool', callId: 'call_9' },
      toolCallId: 'call_9',
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    }))
    const lines = readTranscript(env.root, 'sess-live')
    assert.equal(lines.length, 1)
    const block = lines[0].message.content[0]
    assert.equal(block.type, 'tool_result')
    assert.equal(block.tool_use_id, 'call_9', 'the message-level toolCallId must reach tool_use_id')
    assert.equal(block.is_error, true, 'the message-level isError must reach is_error')
    assert.equal(block.content, 'boom')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-F1: a live v4 image-only tool result contributes the [image] placeholder', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-live-img', header: {} }, liveMessage({
      toolCallId: 'call_img',
      isError: false,
      content: [{ type: 'image', attachment: { attachmentId: 'sha256:zz', name: 'shot.png', bytes: 9 } }],
    }))
    const block = readTranscript(env.root, 'sess-live-img')[0].message.content[0]
    assert.equal(block.tool_use_id, 'call_img')
    assert.equal(block.content, '[image]', 'an image-only result must not collapse to empty content')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-F1: a live v4 file-only tool result keeps its name, size and path handle', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-live-file', header: {} }, liveMessage({
      toolCallId: 'call_file',
      isError: false,
      content: [{
        type: 'file',
        attachment: {
          attachmentId: 'sha256:' + 'c'.repeat(64),
          name: 'artifact.bin',
          bytes: 2048,
          readonlyPath: '/tmp/objects/artifact.bin',
        },
      }],
    }))
    const block = readTranscript(env.root, 'sess-live-file')[0].message.content[0]
    assert.equal(block.tool_use_id, 'call_file')
    assert.notEqual(block.content, '', 'a file-only result must not collapse to empty content')
    assert.match(block.content, /name="artifact\.bin"/)
    assert.match(block.content, /bytes=2048/)
    assert.ok(block.content.includes('{"file_path":"/tmp/objects/artifact.bin"}'), block.content)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-F1: an identical re-delivery of the same live v4 tool result is appended once', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    const session = { id: 'sess-live-dedupe', header: {} }
    const message = liveMessage({
      toolCallId: 'call_dup',
      isError: true,
      content: [{ type: 'text', text: 'same failure' }],
    })
    emitToolResult(handlers, session, message)
    emitToolResult(handlers, session, message)
    const lines = readTranscript(env.root, 'sess-live-dedupe')
    assert.equal(lines.length, 1, 'identical re-delivery for the same tool_use_id must be dropped')
    assert.equal(lines[0].message.content[0].tool_use_id, 'call_dup')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

// --- T-ADV4-04 (INFO, pre-existing): the tool-result path's generic
//     `typeof block.text === 'string'` fallback included a reasoning block, so a
//     live v4 tool result whose content mixes reasoning and text leaked private
//     reasoning text into the transcript. ContentBlock is role-neutral, so the
//     shape is type-legal. Only `reasoning` is excluded; an unknown text-bearing
//     block keeps its existing pass-through behaviour.
test('T-ADV4-04: a reasoning block in a live v4 tool result is excluded from the transcript', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-live-reasoning', header: {} }, liveMessage({
      toolCallId: 'call_reasoning',
      isError: false,
      content: [
        { type: 'reasoning', text: 'PRIVATE' },
        { type: 'text', text: 'visible' },
      ],
    }))
    const lines = readTranscript(env.root, 'sess-live-reasoning')
    assert.equal(lines.length, 1)
    const block = lines[0].message.content[0]
    assert.equal(block.tool_use_id, 'call_reasoning')
    assert.equal(block.content, 'visible',
      'only the text block may reach the transcript, got ' + JSON.stringify(block.content))
    assert.ok(!JSON.stringify(lines[0]).includes('PRIVATE'),
      'reasoning text must not leak into the transcript: ' + JSON.stringify(lines[0]))
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-ADV4-04 control: an unknown non-reasoning text-bearing block is still kept', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-live-unknown-block', header: {} }, liveMessage({
      toolCallId: 'call_unknown',
      isError: false,
      content: [
        { type: 'notice', text: 'kept text' },
        { type: 'text', text: 'visible' },
      ],
    }))
    const block = readTranscript(env.root, 'sess-live-unknown-block')[0].message.content[0]
    assert.equal(block.content, 'kept text' + LF + 'visible',
      'an unknown non-reasoning text block must keep its existing behaviour, got ' + JSON.stringify(block.content))
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-F1 control: a legacy block-level toolCallId result still maps (replay compatibility)', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    // The retired v3 wrapper is what session-format-v3-to-v4 rewrites on import; a
    // replay can still deliver it, so the adapter must keep accepting it.
    emitToolResult(handlers, { id: 'sess-legacy', header: {} }, {
      content: [{
        type: 'tool-result',
        toolCallId: 'call_v3_1',
        content: [{ type: 'text', text: 'ok' }],
        isError: true,
      }],
    })
    const block = readTranscript(env.root, 'sess-legacy')[0].message.content[0]
    assert.equal(block.tool_use_id, 'call_v3_1', 'the legacy block-level toolCallId must still map')
    assert.equal(block.is_error, true, 'the legacy block-level isError must still map')
    assert.equal(block.content, 'ok')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

// --- T-ADV5-04: a legacy v3 tool-result wrapper may carry bare strings inside
// its nested content array. textOf() mapped only typed blocks, so a bare string
// was dropped - the reasoning block is correctly excluded, but the visible text
// vanished with it. Required: keep strings at any nesting level; never reason.
test('T-ADV5-04: a bare string inside a nested legacy tool-result array survives (reasoning excluded)', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-legacy-string', header: {} }, {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_legacy_string',
        content: ['keep', { type: 'reasoning', text: 'PRIVATE' }],
        isError: false,
      }],
    })
    const lines = readTranscript(env.root, 'sess-legacy-string')
    assert.equal(lines.length, 1)
    const block = lines[0].message.content[0]
    assert.equal(block.tool_use_id, 'call_legacy_string')
    assert.equal(block.content, 'keep',
      'a bare string in a nested tool-result content array must be kept, got ' + JSON.stringify(block.content))
    assert.ok(!JSON.stringify(lines[0]).includes('PRIVATE'),
      'reasoning text must not leak into the transcript: ' + JSON.stringify(lines[0]))
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

// T-ADV5-04 control: the top-level string path already worked and must keep
// working - the fix widens textOf(), it must not narrow blockTextOf().
test('T-ADV5-04 control: a bare top-level string block is still kept', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    emitToolResult(handlers, { id: 'sess-top-string', header: {} }, {
      role: 'tool',
      toolCallId: 'call_top_string',
      isError: false,
      content: ['top-level keep', { type: 'text', text: 'visible' }],
    })
    const block = readTranscript(env.root, 'sess-top-string')[0].message.content[0]
    assert.equal(block.tool_use_id, 'call_top_string')
    assert.equal(block.content, 'top-level keep' + LF + 'visible',
      'existing top-level string behaviour must be preserved, got ' + JSON.stringify(block.content))
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

// --- T-ADV6-02 (LOW, transcript fidelity): a tool/result that maps to NO text must
//     append no transcript line at all. The README's transcript contract excludes
//     "reasoning blocks, and empty content lines", and appendUser enforces the same
//     invariant; the tool-result path only filtered falsy mapped blocks, so a
//     reasoning-only or empty-text result still appended a tool_result with
//     content:''. An empty mapped result is not transcript content: the skip happens
//     before appendToolResult, so nothing is appended and no dedupe fingerprint is
//     recorded.
function transcriptLinesIfAny(root, sessionId) {
  const path = join(root, sessionId, 'transcript.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(LF).filter(Boolean).map((line) => JSON.parse(line))
}

test('T-ADV6-02: a live tool result whose mapped text is empty appends no transcript line', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    const shapes = [
      ['reasoning-only', [{ type: 'reasoning', text: 'PRIVATE' }]],
      ['empty-text', [{ type: 'text', text: '' }]],
    ]
    for (const [label, content] of shapes) {
      const session = { id: 'sess-empty-' + label, header: {} }
      emitToolResult(handlers, session, liveMessage({ toolCallId: 'call_' + label, isError: false, content }))
      assert.equal(transcriptLinesIfAny(env.root, session.id).length, 0,
        label + ': a result with no mapped text must not append an empty line')
      // An empty RE-DELIVERY must add nothing either (it is not content the first time).
      emitToolResult(handlers, session, liveMessage({ toolCallId: 'call_' + label, isError: false, content }))
      const lines = transcriptLinesIfAny(env.root, session.id)
      assert.equal(lines.length, 0, label + ': an empty re-delivery must not append a line')
      if (existsSync(join(env.root, session.id, 'transcript.jsonl'))) {
        assert.equal(readFileSync(join(env.root, session.id, 'transcript.jsonl'), 'utf8').includes('PRIVATE'), false,
          label + ': reasoning text must never reach the transcript')
      }
    }
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-ADV6-02 control: a non-empty live tool result still appends exactly one line, and an empty re-delivery adds nothing', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
    const session = { id: 'sess-empty-control', header: {} }
    emitToolResult(handlers, session, liveMessage({
      toolCallId: 'call_real',
      isError: false,
      content: [{ type: 'text', text: 'real output' }],
    }))
    const lines = transcriptLinesIfAny(env.root, session.id)
    assert.equal(lines.length, 1, 'a non-empty result appends exactly one line')
    assert.equal(lines[0].message.content[0].tool_use_id, 'call_real')
    assert.equal(lines[0].message.content[0].content, 'real output')

    // Empty results arriving afterwards must not add an empty line beside the real one.
    emitToolResult(handlers, session, liveMessage({
      toolCallId: 'call_empty_after',
      isError: false,
      content: [{ type: 'text', text: '' }],
    }))
    emitToolResult(handlers, session, liveMessage({
      toolCallId: 'call_reasoning_after',
      isError: false,
      content: [{ type: 'reasoning', text: 'PRIVATE' }],
    }))
    assert.equal(transcriptLinesIfAny(env.root, session.id).length, 1,
      'empty results must not append beside a real line')

    // T-ADV7-03 update: this batch-8 control is extended to the NEW invariant at the
    // direct-append API - appendToolResult with empty content (or with a 0 cap that
    // makes a non-empty result store as '') writes no line and records no dedupe
    // fingerprint. The event-path skip above is no longer the only layer enforcing it.
    const direct = createTranscriptManager({ dir: env.root })
    const directWriter = direct.writerFor('sess-direct-empty')
    directWriter.appendToolResult({ callId: 'call_empty_direct', content: '', isError: false })
    assert.equal(transcriptLinesIfAny(env.root, 'sess-direct-empty').length, 0,
      'appendToolResult with empty content must append no line')
    assert.equal(direct.__dedupeStats('sess-direct-empty').fingerprints, 0,
      'appendToolResult with empty content must record no dedupe fingerprint')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

// --- T-ADV7-03 (batch 10): transcript.maxToolResultChars: 0 is documented as valid.
//     A non-empty live tool result then stores as '', and the event path wrote a
//     tool_result line with content:'' - the README excludes empty content lines.
//     Required: no line at all. The library-level no-fingerprint half of the
//     invariant is pinned by tests/transcript.test.mjs (T-ADV7-03); truncation > 0
//     is pinned by the control below and by the pre-existing truncation tests.
test('T-ADV7-03: a non-empty tool result with maxToolResultChars 0 appends no empty-content line', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, {
      clawmemBin: env.bin,
      transcript: { dir: env.root, rotation: { enabled: false }, maxToolResultChars: 0 },
    })
    const session = { id: 'sess-zero-cap', header: {} }
    const message = liveMessage({
      toolCallId: 'call_zero',
      isError: false,
      content: [{ type: 'text', text: 'hello' }],
    })
    emitToolResult(handlers, session, message)
    assert.equal(transcriptLinesIfAny(env.root, session.id).length, 0,
      'a non-empty result truncated to empty must not append an empty-content line')
    emitToolResult(handlers, session, message)
    assert.equal(transcriptLinesIfAny(env.root, session.id).length, 0,
      'the empty re-delivery must add nothing either')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('T-ADV7-03 control: maxToolResultChars > 0 still writes the truncated line', () => {
  const env = setup()
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, {
      clawmemBin: env.bin,
      transcript: { dir: env.root, rotation: { enabled: false }, maxToolResultChars: 1 },
    })
    const session = { id: 'sess-small-cap', header: {} }
    emitToolResult(handlers, session, liveMessage({
      toolCallId: 'call_small',
      isError: false,
      content: [{ type: 'text', text: 'hello' }],
    }))
    const lines = transcriptLinesIfAny(env.root, session.id)
    assert.equal(lines.length, 1, 'a cap above 0 still writes exactly one line')
    assert.equal(lines[0].message.content[0].content, 'h',
      'the stored content is still the truncation of the result')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})
