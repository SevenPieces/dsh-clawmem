import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  accessSync,
  constants as fsConstants,
  symlinkSync,
  utimesSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

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

// --- T-ADV2-01: rotation ownership - a directory is removable only when EVERY
// entry is a known plugin artifact. ADV-01 taught the classifier to recognise
// memory/ shapes, but the marker checks were presence-only: transcript.jsonl or
// memory/precompact-state.md authorized deleting the WHOLE session dir, including
// foreign files beside or inside it, and a DIRECTORY carrying a marker's name was
// treated as the marker. The rule pinned here: at the session-dir root only a
// regular transcript.jsonl and a real memory/ directory are ours; inside memory/
// only a regular precompact-state.md is ours; nothing else may be swept away, and
// a symlink never stands in for either directory.

const ORIGIN_OLD = new Date('2020-01-01T00:00:00Z');

/** Age every path under target (following symlinks) so no child keeps a fresh mtime. */
function ageTree(target) {
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) ageTree(join(target, name));
  }
  utimesSync(target, ORIGIN_OLD, ORIGIN_OLD);
}

/**
 * Build one aged session dir (session-x) under <host>/transcripts and return the
 * manager that sweeps it. The host is a fresh temp dir, so a case may place files
 * outside the swept base dir (symlink targets). build(sessionDir, host) creates
 * the shape under test.
 */
function agedStoreCase(build) {
  const host = tmpRoot();
  const base = join(host, 'transcripts');
  mkdirSync(base, { recursive: true });
  const session = join(base, 'session-x');
  mkdirSync(session, { recursive: true });
  build(session, host);
  ageTree(session);
  const manager = createTranscriptManager({
    dir: base,
    rotation: { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 },
  });
  return { host, session, manager };
}

test('T-ADV2-01 rotation: an aged dir whose only entry is transcript.jsonl is REMOVED', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    writeFileSync(join(s, 'transcript.jsonl'), '{"old":true}' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'a lone regular transcript.jsonl is a plugin artifact, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged session dir must be gone');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged dir with transcript.jsonl + an empty memory/ is REMOVED', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    writeFileSync(join(s, 'transcript.jsonl'), '{"old":true}' + LF);
    mkdirSync(join(s, 'memory'));
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'both entries are known artifacts, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged session dir must be gone');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged dir whose only entry is memory/precompact-state.md is REMOVED', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    mkdirSync(join(s, 'memory'));
    writeFileSync(join(s, 'memory', 'precompact-state.md'), 'state' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'a lone regular precompact-state.md is a plugin artifact, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged session dir must be gone');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged EMPTY dir is REMOVED', () => {
  const { host, session, manager } = agedStoreCase(() => {});
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'an empty dir holds no foreign content, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged empty dir must be gone');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged dir whose only entry is an empty memory/ is REMOVED', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    mkdirSync(join(s, 'memory'));
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
      'the plugin-created empty memory/ is not foreign content, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(session), false, 'the aged session dir must be gone');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged dir with transcript.jsonl + foreign.md is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    writeFileSync(join(s, 'transcript.jsonl'), '{"old":true}' + LF);
    writeFileSync(join(s, 'foreign.md'), 'user notes beside the transcript' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a transcript beside foreign content must not authorize deleting it, got: ' + JSON.stringify(summary));
    assert.equal(readFileSync(join(session, 'foreign.md'), 'utf8'), 'user notes beside the transcript' + LF,
      'the foreign file must survive');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged dir with precompact-state.md + memory/user-notes.md is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    mkdirSync(join(s, 'memory'));
    writeFileSync(join(s, 'memory', 'precompact-state.md'), 'state' + LF);
    writeFileSync(join(s, 'memory', 'user-notes.md'), 'important user content' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a marker must not imply ownership of its sibling files, got: ' + JSON.stringify(summary));
    assert.equal(readFileSync(join(session, 'memory', 'user-notes.md'), 'utf8'), 'important user content' + LF,
      'the foreign memory file must survive');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged dir with precompact-state.md + a hidden memory/.keep is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    mkdirSync(join(s, 'memory'));
    writeFileSync(join(s, 'memory', 'precompact-state.md'), 'state' + LF);
    writeFileSync(join(s, 'memory', '.keep'), 'keep me' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a hidden sibling is still foreign content, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(join(session, 'memory', '.keep')), true, 'the hidden file must survive');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: a DIRECTORY named transcript.jsonl is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    mkdirSync(join(s, 'transcript.jsonl'));
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a directory is not the transcript marker file, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(join(session, 'transcript.jsonl')), true, 'the directory must survive');
    assert.equal(statSync(join(session, 'transcript.jsonl')).isDirectory(), true);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: a DIRECTORY named memory/precompact-state.md is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    mkdirSync(join(s, 'memory'));
    mkdirSync(join(s, 'memory', 'precompact-state.md'));
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a directory is not the precompact-state.md marker file, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(join(session, 'memory', 'precompact-state.md')), true, 'the directory must survive');
    assert.equal(statSync(join(session, 'memory', 'precompact-state.md')).isDirectory(), true);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: a symlink named memory is KEPT, even when its target holds precompact-state.md',
  { skip: process.platform === 'win32' ? 'directory symlinks need extra privileges on win32' : false }, () => {
  const { host, session, manager } = agedStoreCase((s, h) => {
    const outside = join(h, 'outside-memory');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'precompact-state.md'), 'state outside the session' + LF);
    symlinkSync(outside, join(s, 'memory'), 'dir');
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a symlink is not the plugin-created memory/ directory, got: ' + JSON.stringify(summary));
    assert.equal(existsSync(join(session, 'memory')), true, 'the symlink must survive');
    assert.equal(readFileSync(join(session, 'memory', 'precompact-state.md'), 'utf8'),
      'state outside the session' + LF, 'the symlink target must be untouched');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: an aged foreign dir with a normal file is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    writeFileSync(join(s, 'notes.txt'), 'ordinary user file' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a foreign aged directory must be kept and counted, got: ' + JSON.stringify(summary));
    assert.equal(readFileSync(join(session, 'notes.txt'), 'utf8'), 'ordinary user file' + LF,
      'its contents must survive');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV2-01 rotation: a dir whose only entry is a FILE named memory is KEPT', () => {
  const { host, session, manager } = agedStoreCase((s) => {
    writeFileSync(join(s, 'memory'), 'a regular file, not the plugin memory dir' + LF);
  });
  try {
    const summary = manager.sweep();
    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a file named memory is not the plugin-created directory, got: ' + JSON.stringify(summary));
    assert.equal(statSync(join(session, 'memory')).isFile(), true, 'the file must survive');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

// --- T-ADV2-02: tool-result de-duplication must use the FULL result content,
// not the post-truncation text. With the default maxToolResultChars 500, two
// distinct results sharing their first 500 chars collided and the second was
// silently dropped. The stored line stays truncated at 500 chars; only the
// de-dupe identity sees the whole result.

test('T-ADV2-02: two results sharing the first 500 chars but differing in the tail are BOTH stored', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root }); // shipped default cap: 500
    const writer = manager.writerFor('s1');
    const shared = 'A'.repeat(500);

    writer.appendToolResult({ callId: 'long', content: shared + 'TAIL-ONE', isError: false });
    writer.appendToolResult({ callId: 'long', content: shared + 'TAIL-TWO', isError: false });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 2,
      'the second distinct result must not be dropped because its truncated prefix matches, got: ' +
        JSON.stringify(lines.map((line) => line.message.content[0].content)));
    for (const line of lines) {
      const block = line.message.content[0];
      assert.equal(block.type, 'tool_result');
      assert.equal(block.tool_use_id, 'long');
      assert.equal(block.is_error, false);
      assert.equal(block.content.length, 500, 'the stored result stays truncated at the 500-char cap');
      assert.equal(block.content, shared, 'the stored content is the 500-char prefix');
    }
  });
});

test('T-ADV2-02: an identical full re-delivery is still de-duped (one line) after truncation', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');
    const long = 'A'.repeat(500) + 'TAIL-ONE';

    writer.appendToolResult({ callId: 'long', content: long, isError: false });
    writer.appendToolResult({ callId: 'long', content: long, isError: false });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 1, 'an identical full re-delivery must stay one line, got: ' + lines.length);
    assert.equal(lines[0].message.content[0].content.length, 500);
    assert.equal(lines[0].message.content[0].content, 'A'.repeat(500));
  });
});

test('T-ADV2-02: the same first 500 chars with a different isError yields two lines', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');
    const result = 'A'.repeat(500) + 'TAIL-ONE';

    writer.appendToolResult({ callId: 'long', content: result, isError: false });
    writer.appendToolResult({ callId: 'long', content: result, isError: true });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 2, 'a changed is_error is a different result, got: ' + lines.length);
    assert.deepEqual(
      lines.map((line) => [line.message.content[0].content, line.message.content[0].is_error]),
      [['A'.repeat(500), false], ['A'.repeat(500), true]],
    );
  });
});

// --- V3-01: the de-dupe identity must distinguish strings that are distinct as
// UTF-16 but collide as UTF-8. Node's UTF-8 encoder replaces an unpaired
// surrogate with U+FFFD, so hashing the full text as UTF-8 made 'A\uD800B' and
// 'A\uFFFDB' share one fingerprint and silently dropped the second distinct
// result for the same callId. The identity must live on the UTF-16 code units.

const LONE_SURROGATE = 'A\uD800B';
const REPLACEMENT_CHAR = 'A\uFFFDB';

test('T-V3-01: two results for one callId that differ only in an unpaired surrogate are BOTH stored', async () => {
  // Guard the premise: these are distinct JS strings whose UTF-8 encodings are
  // byte-identical, so a UTF-8-based digest cannot tell them apart. If this
  // ever stops holding, the test would silently stop exercising the bug.
  assert.notEqual(LONE_SURROGATE, REPLACEMENT_CHAR, 'the pair must be distinct UTF-16 strings');
  assert.ok(
    Buffer.from(LONE_SURROGATE, 'utf8').equals(Buffer.from(REPLACEMENT_CHAR, 'utf8')),
    'the pair must collide under UTF-8 so this test exercises the surrogate-blind digest',
  );

  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'surrogate', content: LONE_SURROGATE, isError: false });
    writer.appendToolResult({ callId: 'surrogate', content: REPLACEMENT_CHAR, isError: false });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 2,
      'a result differing only in an unpaired surrogate is a different result, got: ' +
        JSON.stringify(lines.map((line) => line.message.content[0].content)));
    assert.deepEqual(
      lines.map((line) => line.message.content[0].content),
      [LONE_SURROGATE, REPLACEMENT_CHAR],
      'both distinct UTF-16 strings must be stored verbatim, in delivery order',
    );
  });
});

test('T-V3-01: an identical unpaired-surrogate re-delivery is still de-duped (one line)', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'surrogate', content: LONE_SURROGATE, isError: false });
    writer.appendToolResult({ callId: 'surrogate', content: LONE_SURROGATE, isError: false });

    const lines = readLines(writer.path);
    assert.equal(lines.length, 1, 'an identical re-delivery must stay one line, got: ' + lines.length);
    assert.equal(lines[0].message.content[0].content, LONE_SURROGATE);
    assert.equal(lines[0].message.content[0].is_error, false);
  });
});

// --- T-ADV5-02: the rotation mtime walk must not follow symlinks. sweep() is
// synchronous and runs at activation and on every interval; newestMtimeMs()
// stat'ed each entry and recursed into any directory, a symlink target included.
// A symlink to /usr therefore walked ~100k system files inside the host event
// loop and did not finish in 12 s in a bounded probe, freezing the DSH session.
// Required: lstat the entry itself and never descend into a symlink. Because a
// pre-fix sweep would block this process's event loop (a timeout registered here
// could never fire), the sweep runs in a child process with a hard timeout; the
// expected red is that timeout, or a reported sweep elapsed >= 2000 ms.

const POSIX_LARGE_DIR = '/usr';
const LARGE_DIR_SKIP = (() => {
  if (process.platform === 'win32') return 'symlink creation needs extra privileges on win32';
  try {
    if (!lstatSync(POSIX_LARGE_DIR).isDirectory()) return POSIX_LARGE_DIR + ' is not a directory';
    accessSync(POSIX_LARGE_DIR, fsConstants.R_OK);
  } catch (err) {
    return POSIX_LARGE_DIR + ' is not readable: ' + String((err && err.message) || err);
  }
  return false;
})();
const SYMLINK_SKIP = process.platform === 'win32' ? 'symlink creation needs extra privileges on win32' : false;

test('T-ADV5-02: sweep() never follows a symlink to a large external directory', { skip: LARGE_DIR_SKIP }, () => {
  const host = tmpRoot();
  const base = join(host, 'transcripts');
  const session = join(base, 'session-symlink-large');
  try {
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, 'transcript.jsonl'), '{"kept":true}' + LF);
    const old = new Date(Date.now() - 400 * DAY_MS);
    utimesSync(join(session, 'transcript.jsonl'), old, old);
    utimesSync(session, old, old);
    // Created last, so the link's OWN mtime is fresh while everything else in
    // the store is aged.
    const link = join(session, 'large-external');
    symlinkSync(POSIX_LARGE_DIR, link, 'dir');
    const linkMtime = lstatSync(link).mtimeMs;
    assert.ok(Date.now() - linkMtime < 60 * 1000, 'the symlink itself was just created');

    // A synchronous sweep would block this process, so a timeout registered in
    // it could never fire; fork the sweep into a child that can be SIGTERM'd.
    const libUrl = new URL('../lib/transcript.js', import.meta.url).href;
    const runner = join(host, 'sweep-runner.mjs');
    writeFileSync(runner, [
      'import { createTranscriptManager } from ' + JSON.stringify(libUrl) + ';',
      'const manager = createTranscriptManager({ dir: ' + JSON.stringify(base) +
        ', rotation: { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 } });',
      'const startedAt = Date.now();',
      'const summary = manager.sweep();',
      'process.stdout.write(JSON.stringify({ summary, elapsedMs: Date.now() - startedAt }));',
    ].join(LF));

    const child = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 4000 });
    assert.notEqual(child.error && child.error.code, 'ETIMEDOUT',
      'sweep() did not return within 4000 ms: the symlink target was walked (expected lstat + no descent); stdout=' +
        JSON.stringify(child.stdout) + ' stderr=' + JSON.stringify(child.stderr));
    assert.equal(child.status, 0, 'the sweep runner must exit cleanly: ' + JSON.stringify(child.stderr));
    const observed = JSON.parse(child.stdout);
    assert.ok(observed.elapsedMs < 2000,
      'sweep() must return quickly; took ' + observed.elapsedMs + ' ms - a symlink target must never be walked');
    assert.deepEqual(observed.summary, { removed: 0, kept: 1, errors: 0 },
      'the aged store holding a fresh symlink must be kept, got ' + JSON.stringify(observed.summary));

    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink must survive');
    assert.equal(existsSync(join(session, 'transcript.jsonl')), true, 'the owned transcript must survive');
    assert.equal(readFileSync(join(session, 'transcript.jsonl'), 'utf8'), '{"kept":true}' + LF,
      'the transcript content must be untouched');
    assert.equal(existsSync(POSIX_LARGE_DIR), true, 'the external target must not be deleted');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

test('T-ADV5-02: a symlink\'s own mtime (lstat) is used and target files are never deleted',
  { skip: SYMLINK_SKIP }, () => {
  const host = tmpRoot();
  const base = join(host, 'transcripts');
  const session = join(base, 'session-symlink-mtime');
  const external = join(host, 'external-store');
  try {
    mkdirSync(session, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(session, 'transcript.jsonl'), '{"kept":true}' + LF);
    writeFileSync(join(external, 'keep.txt'), 'external file that must survive' + LF);
    const old = new Date('2020-01-01T00:00:00Z');
    for (const p of [join(session, 'transcript.jsonl'), session, join(external, 'keep.txt'), external]) {
      utimesSync(p, old, old);
    }
    const link = join(session, 'external-old');
    symlinkSync(external, link, 'dir'); // its own (lstat) mtime is now
    const linkMtime = lstatSync(link).mtimeMs;
    const targetMtime = statSync(external).mtimeMs;
    assert.ok(targetMtime < linkMtime - 365 * DAY_MS,
      'premise: the link target is genuinely aged while the link itself is fresh');

    const summary = createTranscriptManager({ dir: base, rotation: { enabled: true, maxAgeDays: 180 } }).sweep();

    assert.deepEqual(summary, { removed: 0, kept: 1, errors: 0 },
      'a fresh symlink mtime must keep the aged store; got ' + JSON.stringify(summary));
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink must not be followed or deleted');
    assert.equal(readFileSync(join(external, 'keep.txt'), 'utf8'), 'external file that must survive' + LF,
      'no file behind the symlink may be deleted');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

// --- T-ADV5-03: createTranscriptManager is a documented direct API, and its
// rotation.maxAgeDays was not normalised (only the config loader did that). A
// NaN/'abc' value makes `Date.now() - maxAgeDays * DAY_MS` NaN, so every
// `newest >= cutoff` comparison is false and EVERY owned store counts as aged;
// -5 pushes the cutoff into the future and does the same. The manager must
// normalise its own input: a finite value >= 1, else the 180-day default.

const GARBAGE_MAX_AGE_DAYS = [
  ['NaN', NaN],
  ["'abc'", 'abc'],
  ['-5', -5],
];

test('T-ADV5-03: a garbage rotation.maxAgeDays never deletes a recent owned store (normalised to 180)', () => {
  for (const [label, value] of GARBAGE_MAX_AGE_DAYS) {
    const host = tmpRoot();
    const base = join(host, 'transcripts');
    const recent = join(base, 'session-recent');
    const hundredDays = join(base, 'session-100-days');
    try {
      mkdirSync(recent, { recursive: true });
      writeFileSync(join(recent, 'transcript.jsonl'), '{"kept":true}' + LF);
      mkdirSync(hundredDays, { recursive: true });
      writeFileSync(join(hundredDays, 'transcript.jsonl'), '{"kept":true}' + LF);
      const old = new Date(Date.now() - 100 * DAY_MS);
      utimesSync(hundredDays, old, old);
      utimesSync(join(hundredDays, 'transcript.jsonl'), old, old);

      const manager = createTranscriptManager({
        dir: base,
        rotation: { enabled: true, maxAgeDays: value, sweepIntervalHours: 24 },
      });
      const summary = manager.sweep();

      assert.deepEqual(summary, { removed: 0, kept: 2, errors: 0 },
        'maxAgeDays ' + label + ' must normalise to the 180-day default, got ' + JSON.stringify(summary));
      assert.equal(existsSync(recent), true, 'maxAgeDays ' + label + ' must not delete a just-written store');
      assert.equal(readFileSync(join(recent, 'transcript.jsonl'), 'utf8'), '{"kept":true}' + LF);
      assert.equal(existsSync(hundredDays), true, 'a 100-day store is younger than the 180-day fallback');
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  }
});

test('T-ADV5-03 control: the 180-day fallback still removes a genuinely aged store', () => {
  for (const [label, value] of GARBAGE_MAX_AGE_DAYS) {
    const host = tmpRoot();
    const base = join(host, 'transcripts');
    const aged = join(base, 'session-400-days');
    try {
      mkdirSync(aged, { recursive: true });
      writeFileSync(join(aged, 'transcript.jsonl'), '{"kept":true}' + LF);
      const old = new Date(Date.now() - 400 * DAY_MS);
      utimesSync(aged, old, old);
      utimesSync(join(aged, 'transcript.jsonl'), old, old);

      const summary = createTranscriptManager({
        dir: base,
        rotation: { enabled: true, maxAgeDays: value, sweepIntervalHours: 24 },
      }).sweep();

      assert.deepEqual(summary, { removed: 1, kept: 0, errors: 0 },
        'maxAgeDays ' + label + ' must still rotate a 400-day store, got ' + JSON.stringify(summary));
      assert.equal(existsSync(aged), false, 'the 180-day fallback must remove a 400-day store');
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  }
});

// --- T-ADV7-03 (batch 10): appendToolResult must never write an EMPTY-CONTENT
//     tool_result line. maxToolResultChars is documented as any non-negative
//     number, and 0 truncates every result to ''. appendToolResult used to store
//     that empty string (and its dedupe fingerprint); the README contract excludes
//     empty content lines. Required: skip the line entirely and record no
//     fingerprint, so a later real result for the same tool id is unaffected.
//     Non-empty results and truncation > 0 are unchanged.
test('T-ADV7-03: appendToolResult with empty content appends no line and records no dedupe fingerprint', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'empty-1', content: '', isError: false });
    writer.appendToolResult({ callId: 'empty-1', content: '', isError: false });
    assert.equal(existsSync(writer.path), false, 'an empty result must not create a transcript line');
    const emptyStats = manager.__dedupeStats('s1');
    assert.equal(emptyStats.callIds, 0, 'an empty result must not retain a tool_use_id');
    assert.equal(emptyStats.fingerprints, 0, 'an empty result must not retain a dedupe fingerprint');

    // The skip must not occupy the id: the first real result for it is appended.
    writer.appendToolResult({ callId: 'empty-1', content: 'real output', isError: false });
    const lines = readLines(writer.path);
    assert.equal(lines.length, 1, 'a non-empty result still appends exactly one line');
    assert.equal(lines[0].message.content[0].tool_use_id, 'empty-1');
    assert.equal(lines[0].message.content[0].content, 'real output');
    assert.equal(manager.__dedupeStats('s1').fingerprints, 1);

    // maxToolResultChars: 0 makes a NON-empty result store as '' too: no line.
    const zeroManager = createTranscriptManager({ dir: root, maxToolResultChars: 0 });
    const zeroWriter = zeroManager.writerFor('s-zero');
    zeroWriter.appendToolResult({ callId: 'zero', content: 'hello', isError: false });
    assert.equal(existsSync(zeroWriter.path), false,
      'maxToolResultChars 0 must not append an empty-content line');
    assert.equal(zeroManager.__dedupeStats('s-zero').fingerprints, 0,
      'maxToolResultChars 0 must not record a fingerprint for the skipped empty result');

    // Truncation > 0 is unchanged: the stored line carries the truncated text.
    const truncatedManager = createTranscriptManager({ dir: root, maxToolResultChars: 4 });
    const truncatedWriter = truncatedManager.writerFor('s-trunc');
    truncatedWriter.appendToolResult({ callId: 'trunc', content: 'abcdefgh', isError: false });
    const truncated = readLines(truncatedWriter.path);
    assert.equal(truncated.length, 1);
    assert.deepEqual(truncated[0].message.content[0],
      { type: 'tool_result', tool_use_id: 'trunc', content: 'abcd', is_error: false });
  });
});

// --- T-ADV8-01: a transient write failure must not poison de-dupe. ---
//
// A failed append stores nothing but currently records the de-dupe identity
// BEFORE the write, so the next identical re-delivery is silently dropped even
// though no line ever reached the transcript. A transient EACCES on the session
// dir is the cheap deterministic reproduction (write permission on the dir
// controls creating the transcript file).

const CHMOD_DENIAL_SKIP = (() => {
  if (process.platform === 'win32') return 'POSIX mode bits are not available on win32';
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return 'running as root: a 0500 directory does not deny writes';
  }
  return false;
})();

function chmodDeniesWrites(dir) {
  const probe = join(dir, 'write-probe.tmp');
  try {
    writeFileSync(probe, 'probe');
    rmSync(probe, { force: true });
    return false;
  } catch {
    return true;
  }
}

test('T-ADV8-01: a failed tool-result write does not poison de-dupe - the recovered retry is stored',
  { skip: CHMOD_DENIAL_SKIP }, () => {
    const root = tmpRoot();
    try {
      const { logger, calls } = makeLogger();
      const manager = createTranscriptManager({ dir: root, logger });
      const writer = manager.writerFor('s1');
      const dir = join(root, 's1');

      chmodSync(dir, 0o500);
      try {
        assert.equal(chmodDeniesWrites(dir), true, 'premise: a 0500 session dir denies file creation');
        writer.appendToolResult({ callId: 'r1', content: 'first content', isError: false });
        assert.equal(existsSync(writer.path), false, 'premise: the failed attempt stored no line');
        assert.equal(calls.filter((c) => c.level === 'warn').length, 1,
          'the failed attempt must warn, got: ' + JSON.stringify(calls));
      } finally {
        chmodSync(dir, 0o700);
      }

      // The host re-delivers the same tool result after the transient failure.
      writer.appendToolResult({ callId: 'r1', content: 'first content', isError: false });
      assert.ok(existsSync(writer.path),
        'the recovered retry must be stored: the failed attempt must not occupy the de-dupe window');
      const lines = readLines(writer.path);
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0].message.content[0],
        { type: 'tool_result', tool_use_id: 'r1', content: 'first content', is_error: false });

      // A successful duplicate is still de-duplicated.
      writer.appendToolResult({ callId: 'r1', content: 'first content', isError: false });
      assert.equal(readLines(writer.path).length, 1, 'a successful identical re-delivery is still de-duped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('T-ADV8-01: a failed synthesized tool-call write does not poison de-dupe - the recovered retry is stored',
  { skip: CHMOD_DENIAL_SKIP }, () => {
    const root = tmpRoot();
    try {
      const { logger, calls } = makeLogger();
      const manager = createTranscriptManager({ dir: root, logger });
      const writer = manager.writerFor('s2');
      const dir = join(root, 's2');

      chmodSync(dir, 0o500);
      try {
        assert.equal(chmodDeniesWrites(dir), true, 'premise: a 0500 session dir denies file creation');
        writer.appendToolCall({ callId: 'call-1', name: 'read', arguments: '{"file_path":"/a"}' });
        assert.equal(existsSync(writer.path), false, 'premise: the failed attempt stored no line');
        assert.equal(calls.filter((c) => c.level === 'warn').length, 1,
          'the failed attempt must warn, got: ' + JSON.stringify(calls));
      } finally {
        chmodSync(dir, 0o700);
      }

      writer.appendToolCall({ callId: 'call-1', name: 'read', arguments: '{"file_path":"/a"}' });
      assert.ok(existsSync(writer.path),
        'the recovered retry must be stored: the failed attempt must not occupy the de-dupe set');
      const lines = readLines(writer.path);
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0].message.content,
        [{ type: 'tool_use', id: 'call-1', name: 'read', input: { file_path: '/a' } }]);

      writer.appendToolCall({ callId: 'call-1', name: 'read', arguments: '{"file_path":"/a"}' });
      assert.equal(readLines(writer.path).length, 1, 'a successful identical re-delivery is still de-duped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

// The same invariant covers a failed ASSISTANT line that carried a tool_use:
// the id must not be registered when the line never reached the transcript, or
// the later synthesized tool/call for that id is dropped as "already seen".

test('T-ADV8-01: a failed assistant-message write does not poison the synthesized tool-call de-dupe',
  { skip: CHMOD_DENIAL_SKIP }, () => {
    const root = tmpRoot();
    try {
      const { logger, calls } = makeLogger();
      const manager = createTranscriptManager({ dir: root, logger });
      const writer = manager.writerFor('s3');
      const dir = join(root, 's3');

      chmodSync(dir, 0o500);
      try {
        assert.equal(chmodDeniesWrites(dir), true, 'premise: a 0500 session dir denies file creation');
        writer.appendAssistant([{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }]);
        assert.equal(existsSync(writer.path), false, 'premise: the failed attempt stored no line');
        assert.equal(calls.filter((c) => c.level === 'warn').length, 1,
          'the failed attempt must warn, got: ' + JSON.stringify(calls));
      } finally {
        chmodSync(dir, 0o700);
      }

      writer.appendToolCall({ callId: 'c9', name: 'read', arguments: '{}' });
      assert.ok(existsSync(writer.path),
        'the synthesized tool_use must be stored: the failed assistant line must not mark c9 as seen');
      assert.deepEqual(readLines(writer.path).map((line) => line.message.content[0]),
        [{ type: 'tool_use', id: 'c9', name: 'read', input: {} }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

// --- T-ADV8-02: a session dir removed between the base listing and its stat
// is a benign race (it is gone - nothing to keep, nothing to delete); a genuine
// per-entry EACCES is still an error and still warns. ---
//
// The race is made deterministic by a child preload that wraps node:fs: after
// the base readdirSync returns it removes one listed session dir, and it makes
// lstatSync throw EACCES for another one.

test('T-ADV8-02: a vanished session dir is silent; a per-entry EACCES still counts and warns', () => {
  const host = tmpRoot();
  const base = join(host, 'transcripts');
  const vanishing = join(base, 'vanishing');
  const denied = join(base, 'denied');
  const removedOk = join(base, 'removed-ok');
  const fresh = join(base, 'fresh');
  try {
    for (const dir of [vanishing, denied, removedOk, fresh]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'transcript.jsonl'), '{"session":true}' + LF);
    }
    const old = new Date(Date.now() - 400 * DAY_MS);
    for (const dir of [vanishing, denied, removedOk]) {
      utimesSync(join(dir, 'transcript.jsonl'), old, old);
      utimesSync(dir, old, old);
    }

    const libUrl = new URL('../lib/transcript.js', import.meta.url).href;
    const preload = join(host, 'adv8-preload.cjs');
    writeFileSync(preload, [
      "const fs = require('node:fs');",
      'const base = process.env.ADV8_BASE;',
      'const vanishing = process.env.ADV8_VANISHING;',
      'const denied = process.env.ADV8_DENIED;',
      'const realReaddir = fs.readdirSync;',
      'const realLstat = fs.lstatSync;',
      'let armed = true;',
      'fs.readdirSync = function (target, options) {',
      '  const result = realReaddir.call(fs, target, options);',
      '  if (armed && String(target) === base) {',
      '    armed = false;',
      '    fs.rmSync(vanishing, { recursive: true, force: true });',
      '  }',
      '  return result;',
      '};',
      'fs.lstatSync = function (target) {',
      '  if (String(target) === denied) {',
      "    const error = new Error('EACCES: permission denied, lstat ' + denied);",
      "    error.code = 'EACCES';",
      '    throw error;',
      '  }',
      '  return realLstat.apply(fs, arguments);',
      '};',
    ].join(LF));

    const runner = join(host, 'adv8-sweep-runner.mjs');
    writeFileSync(runner, [
      "import { existsSync } from 'node:fs';",
      'const { createTranscriptManager } = await import(' + JSON.stringify(libUrl) + ');',
      'const warns = [];',
      'const logger = {',
      '  warn: (message, meta) => warns.push({ level: "warn", message, meta }),',
      '  info: () => {},',
      '  debug: () => {},',
      '  error: () => {},',
      '};',
      'const summary = createTranscriptManager({',
      '  dir: ' + JSON.stringify(base) + ',',
      '  rotation: { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 },',
      '  logger,',
      '}).sweep();',
      'process.stdout.write(JSON.stringify({',
      '  summary,',
      '  warns,',
      '  deniedExists: existsSync(' + JSON.stringify(denied) + '),',
      '  removedOkExists: existsSync(' + JSON.stringify(removedOk) + '),',
      '  freshExists: existsSync(' + JSON.stringify(fresh) + '),',
      '  vanishingExists: existsSync(' + JSON.stringify(vanishing) + '),',
      '}));',
    ].join(LF));

    const child = spawnSync(process.execPath, ['--require', preload, runner], {
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, {
        ADV8_BASE: base,
        ADV8_VANISHING: vanishing,
        ADV8_DENIED: denied,
      }),
    });
    assert.equal(child.status, 0, 'the sweep runner must exit cleanly: ' + JSON.stringify(child.stderr));
    const observed = JSON.parse(child.stdout);

    assert.equal(observed.summary.errors, 1,
      'only the EACCES entry is an error (the vanished dir is a benign race), got ' + JSON.stringify(observed));
    assert.equal(observed.summary.removed, 1, 'the aged owned control store is still removed');
    assert.equal(observed.warns.length, 1,
      'exactly one warn (the EACCES entry), got ' + JSON.stringify(observed.warns));
    assert.equal(observed.warns[0].meta && observed.warns[0].meta.session, 'denied',
      'the one warn names the EACCES entry: ' + JSON.stringify(observed.warns));
    assert.equal(observed.deniedExists, true, 'the EACCES dir is kept, never deleted');
    assert.equal(observed.removedOkExists, false, 'the aged owned control store is removed');
    assert.equal(observed.freshExists, true, 'a fresh store is kept');
    assert.equal(observed.vanishingExists, false, 'premise: the dir vanished between the listing and its stat');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

// --- T-ADV8-03: only STRING callIds are de-duplication identities. ---
//
// A malformed host (or the documented direct manager API) can hand over null,
// undefined or an object as the tool-call id. Such an id must never be written
// as tool_use_id (a JSON null is not a usable correlation id), and an object
// must not be compared by reference: there is no stable identity to de-dupe, so
// every delivered result/call is stored. String ids keep exact de-duplication.

test('T-ADV8-03: null and undefined tool-result callIds omit tool_use_id', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: null, content: 'null id', isError: false });
    writer.appendToolResult({ callId: undefined, content: 'undefined id', isError: false });
    writer.appendToolResult({ callId: null, content: 'null id', isError: false });

    const blocks = readLines(writer.path).map((line) => line.message.content[0]);
    assert.equal(blocks.length, 3, 'without an id there is no identity to de-duplicate');
    assert.deepEqual(blocks[0], { type: 'tool_result', content: 'null id', is_error: false });
    assert.deepEqual(blocks[1], { type: 'tool_result', content: 'undefined id', is_error: false });
    assert.deepEqual(blocks[2], { type: 'tool_result', content: 'null id', is_error: false });
    assert.equal(Object.hasOwn(blocks[0], 'tool_use_id'), false, 'a null id must not be written as tool_use_id');
    assert.equal(Object.hasOwn(blocks[1], 'tool_use_id'), false, 'an undefined id must not be written as tool_use_id');
  });
});

test('T-ADV8-03: an object tool-result callId omits tool_use_id and is not de-duped by reference identity', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');
    const callId = { k: 1 };

    writer.appendToolResult({ callId, content: 'object result', isError: false });
    writer.appendToolResult({ callId, content: 'object result', isError: false });

    const blocks = readLines(writer.path).map((line) => line.message.content[0]);
    assert.equal(blocks.length, 2, 'an object id must not be de-duped by reference identity');
    for (const block of blocks) {
      assert.deepEqual(block, { type: 'tool_result', content: 'object result', is_error: false });
      assert.equal(Object.hasOwn(block, 'tool_use_id'), false, 'an object id must not be written as tool_use_id');
    }
  });
});

test('T-ADV8-03: non-string synthesized tool-call callIds omit id and are not de-duped by reference identity', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');
    const objectId = { k: 1 };

    writer.appendToolCall({ callId: null, name: 'read', arguments: '{"file_path":"/a"}' });
    writer.appendToolCall({ callId: undefined, name: 'write', arguments: '{"file_path":"/b"}' });
    writer.appendToolCall({ callId: objectId, name: 'read', arguments: '{"file_path":"/a"}' });
    writer.appendToolCall({ callId: objectId, name: 'read', arguments: '{"file_path":"/a"}' });

    const blocks = readLines(writer.path).map((line) => line.message.content[0]);
    assert.equal(blocks.length, 4, 'a null/undefined/object callId has no identity to de-duplicate');
    assert.deepEqual(blocks[0], { type: 'tool_use', name: 'read', input: { file_path: '/a' } });
    assert.deepEqual(blocks[1], { type: 'tool_use', name: 'write', input: { file_path: '/b' } });
    assert.deepEqual(blocks[2], { type: 'tool_use', name: 'read', input: { file_path: '/a' } });
    assert.deepEqual(blocks[3], { type: 'tool_use', name: 'read', input: { file_path: '/a' } });
    for (const block of blocks) {
      assert.equal(Object.hasOwn(block, 'id'), false, 'a non-string callId must not be written as tool_use id');
    }
  });
});

test('T-ADV8-03 control: string ids still de-dupe exactly for results and synthesized calls', async () => {
  await withRoot((root) => {
    const manager = createTranscriptManager({ dir: root });
    const writer = manager.writerFor('s1');

    writer.appendToolResult({ callId: 'r1', content: 'same', isError: false });
    writer.appendToolResult({ callId: 'r1', content: 'same', isError: false });
    writer.appendToolResult({ callId: 'r1', content: 'different', isError: false });
    writer.appendToolCall({ callId: 'c1', name: 'read', arguments: '{}' });
    writer.appendToolCall({ callId: 'c1', name: 'read', arguments: '{}' });

    const blocks = readLines(writer.path).map((line) => line.message.content[0]);
    assert.deepEqual(blocks, [
      { type: 'tool_result', tool_use_id: 'r1', content: 'same', is_error: false },
      { type: 'tool_result', tool_use_id: 'r1', content: 'different', is_error: false },
      { type: 'tool_use', id: 'c1', name: 'read', input: {} },
    ], 'string ids keep exact de-duplication');
  });
});
