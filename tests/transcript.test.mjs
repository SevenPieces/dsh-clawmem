import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createTranscriptManager } from '../lib/transcript.js';
// Namespace import (not a named import) so a missing export fails one test
// instead of breaking the whole file at link time.
import * as transcript from '../lib/transcript.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LF = String.fromCharCode(10);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'clawmem-transcript-'));
}

function makeLogger() {
  const calls = [];
  const rec = (level) => (...args) => calls.push({ level, args });
  const logger = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
  };
  return { logger, calls };
}

function readLines(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

async function withRoot(fn) {
  const root = tmpRoot();
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('pathFor returns <dir>/<sessionId>/transcript.jsonl and creates dirs on demand', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const p = manager.pathFor('sess-1');
    assert.equal(p, join(root, 'sess-1', 'transcript.jsonl'));
    assert.ok(existsSync(join(root, 'sess-1')), 'session dir created on demand');
  });
});

test('appendUser writes a Claude-format user line', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');
    assert.equal(writer.path, join(root, 's1', 'transcript.jsonl'));

    writer.appendUser('hello world');

    assert.deepEqual(readLines(writer.path), [
      { type: 'message', message: { role: 'user', content: 'hello world' } },
    ]);
  });
});

test('appendAssistant maps text and valid-JSON tool-call blocks', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendAssistant([
      { type: 'text', text: 'I will read it' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/a/b.txt"}' },
    ]);

    assert.deepEqual(readLines(writer.path), [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will read it' },
            { type: 'tool_use', id: 'c1', name: 'read', input: { file_path: '/a/b.txt' } },
          ],
        },
      },
    ]);
  });
});

test('appendAssistant keeps raw arguments when tool-call arguments are invalid JSON', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendAssistant([
      { type: 'tool-call', id: 'c2', name: 'write', arguments: 'not json{' },
    ]);

    const [line] = readLines(writer.path);
    assert.deepEqual(line.message.content, [
      { type: 'tool_use', id: 'c2', name: 'write', input: 'not json{' },
    ]);
  });
});

test('appendAssistant maps image to [image], file to real handle text, skips reasoning', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    // Real DSH FileBlock shape (packages/llm/llm/src/types.ts:84-88 +
    // FileAttachmentRef in packages/attachment/attachment/src/types.ts:39-46).
    writer.appendAssistant([
      { type: 'reasoning', text: 'internal thoughts' },
      { type: 'image', mimeType: 'image/png' },
      { type: 'file', attachment: { attachmentId: 'sha256:' + 'e'.repeat(64), name: 'report.pdf', bytes: 12288 } },
    ]);

    const [line] = readLines(writer.path);
    assert.deepEqual(line.message.content, [
      { type: 'text', text: '[image]' },
      { type: 'text', text: '[file name="report.pdf" bytes=12288]' },
    ]);
  });
});

test('appendToolResult writes a user tool_result block and truncates to maxToolResultChars (default 500)', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'c1', content: 'x'.repeat(600), isError: false });

    const [line] = readLines(writer.path);
    assert.equal(line.type, 'message');
    assert.equal(line.message.role, 'user');
    assert.equal(line.message.content.length, 1);
    const block = line.message.content[0];
    assert.equal(block.type, 'tool_result');
    assert.equal(block.tool_use_id, 'c1');
    assert.equal(block.is_error, false);
    assert.equal(block.content.length, 500);
    assert.equal(block.content, 'x'.repeat(500));
  });
});

test('appendToolResult honors a custom maxToolResultChars and isError flag', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root, maxToolResultChars: 4 });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'c9', content: 'abcdefgh', isError: true });

    const [line] = readLines(writer.path);
    assert.deepEqual(line.message.content, [
      { type: 'tool_result', tool_use_id: 'c9', content: 'abcd', is_error: true },
    ]);
  });
});

test('appendToolCall de-dupes by callId against the assistant message and within a session', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendAssistant([
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/a"}' },
    ]);
    // already present in the assistant message -> must be skipped
    writer.appendToolCall({ callId: 'c1', name: 'read', arguments: '{"file_path":"/a"}' });
    // never seen -> synthesized user-role tool_use line
    writer.appendToolCall({ callId: 'c2', name: 'write', arguments: '{"file_path":"/b"}' });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].message.role, 'assistant');
    // L3: the synthesized tool_use line is assistant-role so ClawMem's
    // assistant-only extractors can see it (was 'user' before the fix).
    assert.deepEqual(lines[1], {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c2', name: 'write', input: { file_path: '/b' } },
        ],
      },
    });
  });
});

// --- Regression tests for defects L1 (file handle text), L3 (synthesized
// tool_use role), L4 (tool_result de-duplication), L6 (empty user lines). ---

test('L1: a real DSH file block {type:file,attachment:{...}} yields non-empty handle text with the name', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    // Shape read from packages/llm/llm/src/types.ts:84-88 and
    // packages/attachment/attachment/src/types.ts:39-46 (FileAttachmentRef).
    writer.appendAssistant([
      { type: 'file', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'report.md', bytes: 1234 } },
    ]);

    const [line] = readLines(writer.path);
    const block = line.message.content[0];
    assert.equal(block.type, 'text');
    assert.notEqual(block.text, '', 'file block must not emit empty text');
    assert.match(block.text, /report\.md/);
    assert.match(block.text, /1234/);
  });
});

test('L1: a path exposed by the attachment reference is emitted as an extractable file_path', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendAssistant([
      {
        type: 'file',
        attachment: {
          attachmentId: 'sha256:' + 'b'.repeat(64),
          name: 'notes.md',
          bytes: 42,
          readonlyPath: '/tmp/dsh-fixtures/attachments/v1/files/ab/notes.md',
        },
      },
      { type: 'file', attachment: { attachmentId: 'sha256:' + 'c'.repeat(64), name: 'saved.txt', bytes: 7, path: '/tmp/objects/saved.txt' } },
    ]);

    const [line] = readLines(writer.path);
    const text = line.message.content.map((b) => b.text).join('\n');
    assert.match(text, /notes\.md/);
    assert.ok(text.includes('{"file_path":"/tmp/dsh-fixtures/attachments/v1/files/ab/notes.md"}'));
    assert.ok(text.includes('{"file_path":"/tmp/objects/saved.txt"}'));
  });
});

test('L1: the emitted file handle text is matched by ClawMem extractFilePaths', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');
    writer.appendAssistant([
      {
        type: 'file',
        attachment: { attachmentId: 'sha256:' + 'd'.repeat(64), name: 'spec.md', bytes: 99, readonlyPath: '/tmp/objects/spec.md' },
      },
    ]);

    // Verbatim from ClawMem src/hooks/precompact-extract.ts:66-70.
    const FILE_OP_PATTERNS = [
      /(?:Read|Edit|Write|NotebookEdit)\s+(?:tool\s+)?(?:on\s+)?['"`]?([/~][^\s'"`,;]+)/gi,
      /file_path['":\s]+([/~][^\s'"`,;]+)/gi,
      /(?:Created|Modified|Wrote|Updated|Edited)\s+['"`]?([/~][^\s'"`,;]+)/gi,
    ];
    const content = readLines(writer.path)[0].message.content.map((b) => b.text).join('\n');
    const paths = new Set();
    for (const pattern of FILE_OP_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const p = match[1];
        if (p.length > 10 && p.length < 300 && !p.includes('*')) paths.add(p);
      }
    }
    assert.deepEqual([...paths], ['/tmp/objects/spec.md']);
  });
});

test('L3: a synthesized tool/call without an assistant tool_use emits an ASSISTANT line carrying the tool_use block', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolCall({ callId: 'c2', name: 'write', arguments: '{"file_path":"/b/x.md"}' });
    // identical second tool/call for the same callId -> nothing
    writer.appendToolCall({ callId: 'c2', name: 'write', arguments: '{"file_path":"/b/x.md"}' });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].message.role, 'assistant', 'assistant-scanning extractors must see it');
    assert.deepEqual(lines[0].message.content, [
      { type: 'tool_use', id: 'c2', name: 'write', input: { file_path: '/b/x.md' } },
    ]);
  });
});

test('L3: the synthesized assistant tool_use is still skipped when the assistant message already carried it', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendAssistant([
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/a"}' },
    ]);
    writer.appendToolCall({ callId: 'c1', name: 'read', arguments: '{"file_path":"/a"}' });

    assert.equal(readLines(writer.path).length, 1);
  });
});

test('L4: re-appending the identical tool/result for the same tool_use_id is skipped, a different one is kept', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'c1', content: 'same output', isError: false });
    writer.appendToolResult({ callId: 'c1', content: 'same output', isError: false });
    writer.appendToolResult({ callId: 'c1', content: 'repaired output', isError: false });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 2, 'identical duplicate skipped, different result kept');
    assert.equal(lines[0].message.content[0].tool_use_id, 'c1');
    assert.equal(lines[0].message.content[0].content, 'same output');
    assert.equal(lines[1].message.content[0].content, 'repaired output');
  });
});

test('L4: tool/result de-duplication is per tool_use_id, not global', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'c1', content: 'ok', isError: false });
    writer.appendToolResult({ callId: 'c2', content: 'ok', isError: false });

    assert.equal(readLines(writer.path).length, 2);
  });
});

test('L6: an image-only user message emits no empty-content line', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendUser('');
    assert.equal(existsSync(writer.path), false, 'nothing written for empty content');

    writer.appendUser('real text');
    const lines = readLines(writer.path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].message.content, 'real text');
  });
});

test('L6: no emitted line ever has empty mapped content', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendUser('');
    writer.appendAssistant([]);
    writer.appendAssistant([{ type: 'reasoning', text: 'thoughts only' }]);
    writer.appendAssistant([{ type: 'tool-call', id: '', name: 'x', arguments: '{}' }, { type: 'file', attachment: { name: '', bytes: 0 } }]);

    const lines = readLines(writer.path);
    for (const line of lines) {
      const content = line.message.content;
      if (typeof content === 'string') assert.notEqual(content, '');
      else for (const block of content) assert.ok(JSON.stringify(block) !== '{}' && !(block.type === 'text' && block.text === ''), JSON.stringify(block));
    }
  });
});

// --- N-7: the single shared, path-bearing file-handle formatter. ---

test('N-7: fileHandleText is exported and is the one path-bearing handle format', () => {
  assert.equal(typeof transcript.fileHandleText, 'function', 'transcript.js must export the shared helper');
  const fileHandleText = transcript.fileHandleText;

  // Path-less FileAttachmentRef: name + size always survive, no invented path.
  const plain = fileHandleText({ type: 'file', attachment: { attachmentId: 'sha256:' + 'e'.repeat(64), name: 'report.pdf', bytes: 12288 } });
  assert.equal(plain, '[file name="report.pdf" bytes=12288]');

  // A path exposed by the block or its attachment becomes the extractable JSON token.
  const withRefPath = fileHandleText({ type: 'file', attachment: { name: 'n.md', bytes: 1, readonlyPath: '/tmp/objects/n.md' } });
  assert.ok(withRefPath.includes('{"file_path":"/tmp/objects/n.md"}'), withRefPath);
  const withBlockPath = fileHandleText({ type: 'file', path: '/tmp/objects/at-block.md', attachment: { name: 'b.md', bytes: 2 } });
  assert.ok(withBlockPath.includes('{"file_path":"/tmp/objects/at-block.md"}'), withBlockPath);

  // Never empty for a file block.
  assert.notEqual(fileHandleText({ type: 'file' }), '');
});

test('de-dupe state is shared across writerFor calls for the same session', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    manager
      .writerFor('s1')
      .appendAssistant([{ type: 'tool-call', id: 'c7', name: 'read', arguments: '{}' }]);
    const writer = manager.writerFor('s1');

    writer.appendToolCall({ callId: 'c7', name: 'read', arguments: '{}' });

    assert.equal(readLines(writer.path).length, 1);
  });
});

test('sweep removes aged session dirs, keeps fresh ones, ignores loose files, and logs', async () => {
  await withRoot((root) => {
    const aged = join(root, 'aged-session');
    const fresh = join(root, 'fresh-session');
    mkdirSync(aged, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(aged, 'transcript.jsonl'), '{"old":true}\n');
    writeFileSync(join(fresh, 'transcript.jsonl'), '{"fresh":true}\n');
    writeFileSync(join(root, 'loose.txt'), 'ignore me');

    const old = new Date(Date.now() - 200 * DAY_MS);
    utimesSync(aged, old, old);
    utimesSync(join(aged, 'transcript.jsonl'), old, old);

    const { logger, calls } = makeLogger();
    const manager = createTranscriptManager({
      dir: root,
      logger,
      rotation: { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 },
    });

    const result = manager.sweep();

    assert.equal(existsSync(aged), false, 'aged dir removed');
    assert.equal(existsSync(fresh), true, 'fresh dir kept');
    assert.equal(existsSync(join(root, 'loose.txt')), true, 'loose file kept');
    assert.equal(result.removed, 1);
    assert.equal(result.kept, 1);
    assert.ok(
      calls.some((c) => c.level === 'info'),
      'rotation logs counts via logger',
    );
  });
});

test('sweep is a no-op when rotation is disabled', async () => {
  await withRoot((root) => {
    const aged = join(root, 'aged-session');
    mkdirSync(aged, { recursive: true });
    writeFileSync(join(aged, 'transcript.jsonl'), '{}\n');
    const old = new Date(Date.now() - 900 * DAY_MS);
    utimesSync(aged, old, old);
    utimesSync(join(aged, 'transcript.jsonl'), old, old);

    const { logger } = makeLogger();
    const manager = createTranscriptManager({
      dir: root,
      logger,
      rotation: { enabled: false },
    });

    const result = manager.sweep();

    assert.equal(existsSync(aged), true, 'disabled rotation deletes nothing');
    assert.equal(result.removed, 0);
  });
});

test('write failures are logged, never thrown (fail-open)', async () => {
  await withRoot((root) => {
    // Occupy the session directory path with a regular file so mkdir/append fail.
    writeFileSync(join(root, 's1'), 'not a directory');

    const { logger, calls } = makeLogger();
    const manager = createTranscriptManager({ dir: root, logger });
    const writer = manager.writerFor('s1');

    assert.doesNotThrow(() => {
      writer.appendUser('hi');
      writer.appendAssistant([{ type: 'text', text: 'there' }]);
      writer.appendToolResult({ callId: 'c1', content: 'ok', isError: false });
    });
    assert.ok(
      calls.some((c) => c.level === 'warn' || c.level === 'error'),
      'failure logged via logger',
    );
  });
});

test('close() is safe and idempotent', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    manager.writerFor('s1').appendUser('one');
    assert.doesNotThrow(() => {
      manager.close();
      manager.close();
    });
  });
});

// --- F3 (round 2): the per-session tool_result de-dupe window must be bounded.
// Semantics kept: identical re-delivery of a result still inside the retained
// window is skipped; a result older than the window may be re-emitted - which
// is strictly better than unbounded growth. Different content for the same
// toolCallId is always kept.

test('F3: the retained tool-result de-dupe window is capped - an evicted result is re-emitted, a recent one is still skipped', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root, maxRetainedToolResultFingerprints: 4 });
    const writer = manager.writerFor('s1');

    for (let i = 1; i <= 6; i += 1) {
      writer.appendToolResult({ callId: `c${i}`, content: `result ${i}`, isError: false });
    }
    // The window now holds the 4 most recent fingerprints: results 3..6.
    writer.appendToolResult({ callId: 'c6', content: 'result 6', isError: false }); // recent -> skipped
    writer.appendToolResult({ callId: 'c5', content: 'result 5', isError: false }); // recent -> skipped
    assert.equal(readLines(writer.path).length, 6, 'identical results inside the window are skipped');

    // Result 1 fell out of the window -> it may be re-emitted.
    writer.appendToolResult({ callId: 'c1', content: 'result 1', isError: false });
    const lines = readLines(writer.path);
    assert.equal(lines.length, 7, 'a result evicted from the window is re-emitted');
    assert.equal(lines[6].message.content[0].tool_use_id, 'c1');
    assert.equal(lines[6].message.content[0].content, 'result 1');

    const stats = manager.__dedupeStats('s1');
    assert.equal(stats.cap, 4);
    assert.equal(stats.fingerprints, 4, 'retained fingerprints never exceed the cap');
  });
});

test('F3: identical-repeat skip and different-content-keep still hold inside the window', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root, maxRetainedToolResultFingerprints: 8 });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'c1', content: 'same output', isError: false });
    writer.appendToolResult({ callId: 'c1', content: 'same output', isError: false }); // identical -> skipped
    writer.appendToolResult({ callId: 'c1', content: 'same output', isError: true }); // different is_error -> kept
    writer.appendToolResult({ callId: 'c1', content: 'repaired output', isError: false }); // different content -> kept

    const lines = readLines(writer.path);
    assert.equal(lines.length, 3, 'identical duplicate skipped, different results kept');
    assert.deepEqual(
      lines.map((l) => [l.message.content[0].content, l.message.content[0].is_error]),
      [
        ['same output', false],
        ['same output', true],
        ['repaired output', false],
      ],
    );
    assert.equal(manager.__dedupeStats('s1').fingerprints, 3);
  });
});

test('F3: per-session de-dupe memory stays bounded after far more distinct results than the cap', async () => {
  await withRoot((root) => {
    const cap = 16;
    const n = 5000;
    const manager = createTranscriptManager({ dir: root, maxRetainedToolResultFingerprints: cap });
    const writer = manager.writerFor('s1');

    for (let i = 0; i < n; i += 1) {
      writer.appendToolResult({ callId: `c${i}`, content: `payload ${i}`, isError: false });
    }
    // A second session keeps its own independent, bounded window.
    manager.writerFor('s2').appendToolResult({ callId: 'other-1', content: 'other', isError: false });

    const stats = manager.__dedupeStats('s1');
    assert.equal(stats.cap, cap);
    assert.equal(stats.fingerprints, cap, 'retained fingerprints are bounded by the cap');
    assert.ok(stats.callIds <= cap, 'retained tool_use_ids are bounded by the cap too');
    assert.equal(readLines(writer.path).length, n, 'every distinct result was still written');

    // The oldest result was evicted long ago -> re-emitted; the newest -> skipped.
    writer.appendToolResult({ callId: 'c0', content: 'payload 0', isError: false });
    writer.appendToolResult({ callId: `c${n - 1}`, content: `payload ${n - 1}`, isError: false });
    assert.equal(readLines(writer.path).length, n + 1, 'oldest re-emitted, newest still skipped');

    assert.deepEqual(manager.__dedupeStats('s2'), { cap, callIds: 1, fingerprints: 1 });
    assert.deepEqual(manager.__dedupeStats('never-seen'), { cap, callIds: 0, fingerprints: 0 });
  });
});

test('F3: the default retained window is bounded (2048) on the production path with no cap option', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root }); // no cap option -> shipped default
    const writer = manager.writerFor('s1');
    const n = 2049; // one more than the default window

    for (let i = 0; i < n; i += 1) {
      writer.appendToolResult({ callId: `c${i}`, content: `payload ${i}`, isError: false });
    }

    const stats = manager.__dedupeStats('s1');
    assert.equal(stats.cap, 2048, 'the shipped default cap is finite');
    assert.equal(stats.fingerprints, 2048, 'the default window never exceeds 2048 fingerprints');

    // Oldest result evicted -> re-emitted; newest still inside the window -> skipped.
    writer.appendToolResult({ callId: 'c0', content: 'payload 0', isError: false });
    writer.appendToolResult({ callId: `c${n - 1}`, content: `payload ${n - 1}`, isError: false });
    assert.equal(readLines(writer.path).length, n + 1);
  });
});

// --- T-F5: a fresh DSH_HOME is not a rotation error. ---

test('T-F5: sweep on a not-yet-created transcript dir is silent; an unreadable dir still warns', () => {
  // (1) The documented normal state before the first transcript write: ENOENT is a
  // no-op, not a warn (activation runs one sweep before any writer exists).
  const root = tmpRoot();
  const missing = join(root, 'not-created-yet');
  try {
    const { logger, calls } = makeLogger();
    const manager = createTranscriptManager({ dir: missing, logger });
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 0, errors: 0 }, 'a missing dir is not an error');
    assert.deepEqual(calls.filter((c) => c.level === 'warn' || c.level === 'error'), [],
      'a missing dir must not warn, got: ' + JSON.stringify(calls));
    assert.equal(existsSync(missing), false, 'sweep must not create the transcript dir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // (2) A path that is a regular file cannot be scanned: ENOTDIR is a real error and
  // must keep warning (the fix must special-case only ENOENT).
  const root2 = tmpRoot();
  const notADir = join(root2, 'not-a-dir');
  try {
    writeFileSync(notADir, 'a regular file where the transcript dir should be' + LF);
    const { logger, calls } = makeLogger();
    const manager = createTranscriptManager({ dir: notADir, logger });
    const summary = manager.sweep();
    assert.equal(summary.errors, 1, 'an unreadable dir is still an error');
    assert.equal(summary.removed, 0);
    assert.equal(calls.filter((c) => c.level === 'warn').length, 1, 'the real read failure still warns');
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

// --- T-F6: transcript data is private to the owner. ---

test('T-F6: with a permissive umask the session dir is 0700 and the transcript file 0600',
  { skip: process.platform === 'win32' ? 'POSIX mode bits are not available on win32' : false }, () => {
    const root = tmpRoot();
    const previousUmask = process.umask(0);
    try {
      // umask 0 makes every unset mode bit observable: a default mkdir/append would
      // create 0777/0666, exposing transcripts to every local user.
      const manager = createTranscriptManager({ dir: root });
      manager.writerFor('session-private').appendUser('secret transcript text');

      const dir = join(root, 'session-private');
      const file = join(dir, 'transcript.jsonl');
      const dirMode = statSync(dir).mode & 0o777;
      const fileMode = statSync(file).mode & 0o777;
      assert.equal(dirMode & 0o077, 0, 'session dir is group/world accessible: 0' + dirMode.toString(8));
      assert.equal(fileMode & 0o077, 0, 'transcript file is group/world accessible: 0' + fileMode.toString(8));
      assert.equal(dirMode, 0o700, 'the session dir must be created 0700, got 0' + dirMode.toString(8));
      assert.equal(fileMode, 0o600, 'the transcript file must be created 0600, got 0' + fileMode.toString(8));
    } finally {
      process.umask(previousUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

// --- T-F7: a hostile session id cannot escape the transcript dir. ---

test('T-F7: a hostile session id stays under the configured dir and never becomes "." or ".."',
  { skip: process.platform === 'win32' ? 'path-separator semantics differ on win32' : false }, async () => {
    await withRoot((hostRoot) => {
      // Nest the configured dir so a baseline escape writes inside hostRoot (cleaned
      // up) instead of next to the system temp dir.
      const root = join(hostRoot, 'transcripts');
      mkdirSync(root, { recursive: true });
      const base = resolve(root);
      const manager = createTranscriptManager({ dir: root });
      const pathsOf = (sessionId) => [manager.pathFor(sessionId), manager.writerFor(sessionId).path];

      for (const sessionId of ['../escape', '..', '.']) {
        for (const path of pathsOf(sessionId)) {
          const dir = dirname(resolve(path));
          const rel = relative(base, dir);
          // Check segments, not a string prefix: a single safe segment named '.._escape'
          // is contained even though it starts with two dots.
          assert.ok(rel !== '' && !rel.split(sep).includes('..') && !isAbsolute(rel),
            JSON.stringify(sessionId) + ' escaped the transcript dir: ' + path);
          assert.notEqual(basename(dir), '.', JSON.stringify(sessionId) + ' resolved to ".": ' + path);
          assert.notEqual(basename(dir), '..', JSON.stringify(sessionId) + ' resolved to "..": ' + path);
        }
      }
      // The dot segments must not collapse onto the base dir either.
      for (const sessionId of ['..', '.']) {
        for (const path of pathsOf(sessionId)) {
          assert.equal(dirname(dirname(resolve(path))), base,
            JSON.stringify(sessionId) + ' must become exactly one safe segment under the base dir, got ' + path);
        }
      }

      // A normal id keeps its historical path.
      assert.equal(manager.pathFor('session-abc'), join(root, 'session-abc', 'transcript.jsonl'));
      assert.equal(manager.writerFor('session-abc').path, join(root, 'session-abc', 'transcript.jsonl'));

      // An empty id still needs a real segment: the documented safe placeholder is "_".
      for (const path of pathsOf('')) {
        assert.equal(resolve(path), join(base, '_', 'transcript.jsonl'),
          'an empty session id must become the safe "_" segment, got ' + path);
      }
    });
  });

// --- T-F8: rotation containment - remove only real session dirs. ---

test('T-F8: rotation keeps an aged foreign directory, removes aged session and empty dirs', async () => {
  const age = (path) => {
    const old = new Date(Date.now() - 200 * DAY_MS);
    utimesSync(path, old, old);
  };

  // (1) An aged directory that holds an ordinary file is NOT a transcript session.
  await withRoot((root) => {
    const foreign = join(root, 'notes');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'notes.txt'), 'ordinary user file' + LF);
    age(foreign);
    age(join(foreign, 'notes.txt'));
    const summary = createTranscriptManager({ dir: root }).sweep();
    assert.equal(summary.removed, 0, 'a foreign aged directory must not be removed');
    assert.equal(existsSync(join(foreign, 'notes.txt')), true, 'its contents must survive');
  });

  // (2) An aged session dir with a transcript is still rotated away.
  await withRoot((root) => {
    const session = join(root, 'aged-session');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, 'transcript.jsonl'), '{"old":true}' + LF);
    age(session);
    age(join(session, 'transcript.jsonl'));
    const summary = createTranscriptManager({ dir: root }).sweep();
    assert.equal(summary.removed, 1, 'an aged session dir must be removed');
    assert.equal(existsSync(session), false);
  });

  // (3) An aged EMPTY dir is a session dir that never got its first line: removable.
  await withRoot((root) => {
    const empty = join(root, 'aged-empty');
    mkdirSync(empty, { recursive: true });
    age(empty);
    const summary = createTranscriptManager({ dir: root }).sweep();
    assert.equal(summary.removed, 1, 'an aged empty dir must be removed');
    assert.equal(existsSync(empty), false);
  });

  // (4) A fresh session dir is kept.
  await withRoot((root) => {
    const fresh = join(root, 'fresh-session');
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, 'transcript.jsonl'), '{"fresh":true}' + LF);
    const summary = createTranscriptManager({ dir: root }).sweep();
    assert.equal(summary.removed, 0, 'a fresh session dir must be kept');
    assert.equal(existsSync(fresh), true);
    assert.equal(summary.kept, 1);
  });
});

// --- T-ADV-01: rotation must still reap a plugin-created session dir. ---
// runPrecompact creates <dir>/<id>/memory before the precompact hook runs, so a
// session that never wrote a transcript line can legitimately leave only an empty
// memory/ (hook failed/timed out) or only memory/precompact-state.md. The F-8
// "this is one of our session stores" test must recognise those shapes and rotate
// them like an empty directory; a memory/ that holds anything else is user data
// and keeps the whole directory.

function agePath(target) {
  const old = new Date(Date.now() - 200 * DAY_MS);
  utimesSync(target, old, old);
}

test('T-ADV-01: rotation removes an aged session dir whose only entry is an empty memory/', async () => {
  await withRoot((root) => {
    const session = join(root, 'session-1');
    mkdirSync(join(session, 'memory'), { recursive: true });
    agePath(join(session, 'memory'));
    agePath(session);

    const summary = createTranscriptManager({ dir: root }).sweep();

    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'a session dir holding only the plugin-created empty memory/ must be removed, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged session dir, not just its memory/, must be gone');
  });
});

test('T-ADV-01: rotation removes an aged session dir whose only entry is memory/precompact-state.md', async () => {
  await withRoot((root) => {
    const session = join(root, 'session-2');
    const memory = join(session, 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'precompact-state.md'), 'state' + LF);
    agePath(join(memory, 'precompact-state.md'));
    agePath(memory);
    agePath(session);

    const summary = createTranscriptManager({ dir: root }).sweep();

    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'a precompact-state.md-only session dir must be removed, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged session dir must be gone');
  });
});

test('T-ADV-01: rotation keeps an aged session dir whose memory/ holds another file', async () => {
  await withRoot((root) => {
    const session = join(root, 'session-3');
    const memory = join(session, 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'notes.txt'), 'not ours' + LF);
    agePath(join(memory, 'notes.txt'));
    agePath(memory);
    agePath(session);

    const summary = createTranscriptManager({ dir: root }).sweep();

    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a session dir whose memory/ holds foreign content must be kept, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(join(memory, 'notes.txt')), true, 'the foreign file must survive');
  });
});

test('T-ADV-01: rotation keeps an aged foreign dir with a normal file (counted as kept)', async () => {
  await withRoot((root) => {
    const foreign = join(root, 'notes');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'notes.txt'), 'ordinary user file' + LF);
    agePath(join(foreign, 'notes.txt'));
    agePath(foreign);

    const summary = createTranscriptManager({ dir: root }).sweep();

    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a foreign aged directory must be kept and counted, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(join(foreign, 'notes.txt')), true, 'its contents must survive');
  });
});
