// lib/transcript.js
// ClawMem-readable per-session transcript builder (Claude-transcript compatible).
// Out-of-tree constraint: only node:* builtins are imported here.
import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 500;
export const DEFAULT_ROTATION = Object.freeze({
  enabled: true,
  maxAgeDays: 180,
  sweepIntervalHours: 24,
});

const SAFE_SEGMENT_STRIP = /[^A-Za-z0-9._-]/g;
const DOTS_ONLY = /^\.+$/;

/**
 * F-7: one shared, safe path segment for a session id. A normal DSH id
 * ("session-<uuid>", a bare uuid) passes through unchanged because every
 * character is already in [A-Za-z0-9._-]; anything else becomes '_' so an id
 * such as "..", "a/b" or "\\" can never escape the transcript directory. An
 * empty id maps to '_' and a segment made only of dots maps to the same number
 * of underscores, so the result is never '.' or '..'. Shared by
 * sessionDir()/pathFor() here and the lib/index.js fallback path builder.
 */
export function safeSessionDirSegment(sessionId) {
  const segment = String(sessionId).replace(SAFE_SEGMENT_STRIP, '_');
  if (segment === '') return '_';
  return DOTS_ONLY.test(segment) ? '_'.repeat(segment.length) : segment;
}

/**
 * F3: hard cap on the number of tool_result fingerprints retained per session
 * for exact de-duplication. The retained window is FIFO (oldest evicted
 * first), so a session's de-dupe state is O(cap) instead of O(distinct
 * results). An identical re-delivery inside the window is still skipped; a
 * result older than the window may be re-emitted - strictly better than
 * unbounded growth in a long-lived process. Deliberately NOT exported (the
 * module's supported surface is createTranscriptManager, fileHandleText,
 * safeSessionDirSegment, DEFAULT_MAX_TOOL_RESULT_CHARS, DEFAULT_ROTATION;
 * fileHandleText was added by N-7 so lib/index.js shares one handle format,
 * and safeSessionDirSegment by F-7 for the same reason). Tests and callers can
 * override the cap per manager via maxRetainedToolResultFingerprints.
 */
const DEFAULT_MAX_RETAINED_TOOL_RESULT_FINGERPRINTS = 2048;

/** Positive-integer cap, falling back to the default for junk/infinite input. */
function normalizeRetainedCap(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * ADV5-03: rotation.maxAgeDays reaches the manager from a direct API caller as
 * well as from the plugin config (where it has already been repaired). A
 * non-finite or sub-1 value makes the cutoff comparison false and every store
 * look aged, so the next sweep would delete them all. Normalise the merged
 * value exactly like the config repair - a finite number >= 1 - and fall back
 * to the documented default otherwise.
 */
function normalizeMaxAgeDays(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : fallback;
}

/** Log through ctx.logger without ever letting logging break the loop. */
function safeLog(logger, level, message, meta) {
  if (!logger) return;
  try {
    let fn = null;
    if (typeof logger[level] === 'function') fn = logger[level];
    else if (typeof logger.log === 'function') fn = logger.log;
    if (!fn) return;
    if (meta === undefined) fn.call(logger, message);
    else fn.call(logger, message, meta);
  } catch {
    // Fail-open: a broken logger must not throw into the session loop.
  }
}

function errorText(err) {
  if (!err) return 'unknown error';
  return String((err && err.message) || err);
}

/** Coerce a DSH tool-result payload (string | block[] | object) to plain text. */
function toResultText(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Parse raw JSON tool arguments; keep the raw string when parsing fails. */
function parseArguments(raw) {
  if (typeof raw !== 'string') return raw === undefined ? {} : raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Fields a DSH FileBlock (or the attachment reference it wraps) may expose a
 * readable location through, most authoritative first. The canonical
 * FileAttachmentRef (packages/attachment/attachment/src/types.ts:39-46) is
 * { attachmentId, name, bytes } and is deliberately path-free, so this list is
 * a best-effort probe: a path is only ever used when a shape really carries one.
 */
const FILE_PATH_FIELDS = [
  'path',
  'readonlyPath',
  'readonly_path',
  'savedPath',
  'saved_path',
  'hostPath',
  'host_path',
  'filePath',
  'file_path',
  'readPath',
  'read_path',
];

/** Matches ClawMem's own path shape (precompact-extract.ts:66-70: [/~]... , >10 chars). */
function crediblePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || value.startsWith('~')) && value.length > 10;
}

/** First credible path exposed by a file block or its attachment reference, if any. */
function filePathOf(block) {
  const sources = [];
  if (block && typeof block === 'object') {
    sources.push(block);
    if (block.attachment && typeof block.attachment === 'object') sources.push(block.attachment);
  }
  for (const source of sources) {
    for (const field of FILE_PATH_FIELDS) {
      if (crediblePath(source[field])) return source[field];
    }
  }
  return null;
}

/**
 * Deterministic handle text for a file block (name/size/path).
 * The non-empty name/bytes identity always survives; the path, when the block
 * exposes one, is emitted as {"file_path":"..."} - the exact JSON form DSH
 * flattens tool_use inputs to, and the only form ClawMem's verbatim
 * /file_path['":\s]+([/~][^\s'"`,;]+)/ regex captures (verified: a bare
 * file_path=/x, an angle-bracketed file_path=</x> and a quoted
 * file_path="/x" all fail, because the separator class consumes the quote and
 * a value not starting with / or ~ never matches). Never returns '' when a
 * name or an id exists. N-7: exported and used by BOTH writer paths -
 * lib/transcript.js mapBlock (assistant) and lib/index.js userTextOf (user) -
 * so one file block yields byte-identical text through either path.
 */
export function fileHandleText(block) {
  const ref = block && typeof block.attachment === 'object' && block.attachment ? block.attachment : block;
  const name = typeof ref.name === 'string' && ref.name !== '' ? ref.name : null;
  const bytes = Number.isFinite(ref.bytes) ? ref.bytes : null;
  const path = filePathOf(block);
  const parts = [];
  if (name !== null) parts.push(`name="${name}"`);
  if (bytes !== null) parts.push(`bytes=${bytes}`);
  if (path !== null) parts.push(`{"file_path":${JSON.stringify(path)}}`);
  if (parts.length === 0 && typeof ref.attachmentId === 'string' && ref.attachmentId !== '') {
    parts.push(`attachment="${ref.attachmentId}"`);
  }
  return parts.length === 0 ? '[file]' : `[file ${parts.join(' ')}]`;
}

/** Map one DSH content block to a Claude content block (or null to skip). */
function mapBlock(block) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: typeof block.text === 'string' ? block.text : String(block.text ?? ''),
      };
    case 'tool-call':
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parseArguments(block.arguments !== undefined ? block.arguments : block.input),
      };
    case 'image':
      // ClawMem cannot read bytes; emit a stable placeholder.
      return { type: 'text', text: '[image]' };
    case 'file': {
      // Keep the handle text (name/size/path) so file-path extraction still works.
      // Handle text is the only file representation ClawMem can read; a name is
      // always available, so this block must never map to empty text.
      return { type: 'text', text: fileHandleText(block) };
    }
    default:
      // reasoning and unknown block types are noise -> skipped.
      return null;
  }
}

function truncate(text, maxChars) {
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 0
      ? maxChars
      : DEFAULT_MAX_TOOL_RESULT_CHARS;
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * ADV2-02: de-dupe identity for one tool result - the FULL untruncated text
 * plus the is_error flag, hashed with SHA-256 (hex). Hashing the full text
 * keeps the retained fingerprint O(1) per result regardless of result size,
 * while two results that differ only beyond maxToolResultChars no longer
 * collide. A separator keeps (text, flag) pairs unambiguous.
 *
 * V3-01: hash the text as UTF-16LE, not UTF-8. Node's UTF-8 encoder replaces
 * an unpaired surrogate code unit with U+FFFD, so 'A\uD800B' and 'A\uFFFDB'
 * (distinct results, same callId) would share one digest and the second would
 * be silently dropped. UTF-16LE bytes preserve every code unit, lone
 * surrogates included, so the digest is identity-bearing.
 */
function toolResultFingerprint(fullText, isErrorFlag) {
  return createHash('sha256')
    .update(Buffer.from(fullText, 'utf16le'))
    .update('\u0000')
    .update(isErrorFlag ? '1' : '0')
    .digest('hex');
}

/**
 * Newest mtime (ms) of a path and, if it is a real directory, everything
 * beneath it.
 *
 * ADV5-02: use lstatSync, never statSync - a symbolic link contributes only its
 * own mtime and its target is never entered. This walk is synchronous and runs
 * on activation and every sweep interval, so a followed link blocked the event
 * loop (a link to /usr did not finish). lstat reports a link as a non-directory,
 * so the descent below cannot enter one; the ownership gate independently treats
 * a link as foreign content and keeps that directory.
 */
function newestMtimeMs(entryPath) {
  const st = lstatSync(entryPath);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    let children = [];
    try {
      children = readdirSync(entryPath);
    } catch {
      children = [];
    }
    for (const name of children) {
      try {
        newest = Math.max(newest, newestMtimeMs(join(entryPath, name)));
      } catch {
        // Unreadable child: keep the parent's mtime.
      }
    }
  }
  return newest;
}

export function createTranscriptManager({
  dir,
  maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  maxRetainedToolResultFingerprints = DEFAULT_MAX_RETAINED_TOOL_RESULT_FINGERPRINTS,
  rotation,
  logger,
} = {}) {
  const baseDir = dir;
  const rotationCfg = { ...DEFAULT_ROTATION, ...(rotation || {}) };
  // ADV5-03: the sweep below must never see a NaN/junk age.
  rotationCfg.maxAgeDays = normalizeMaxAgeDays(rotationCfg.maxAgeDays, DEFAULT_ROTATION.maxAgeDays);
  const retainedCap = normalizeRetainedCap(
    maxRetainedToolResultFingerprints,
    DEFAULT_MAX_RETAINED_TOOL_RESULT_FINGERPRINTS,
  );
  // Per-session de-dupe of tool_use callIds (shared across writerFor calls).
  const seenBySession = new Map();
  // Per-session de-dupe of appended tool results, keyed by tool_use_id ->
  // Set of SHA-256 fingerprints of the FULL untruncated result text plus
  // is_error (ADV2-02), so a re-delivered identical tool/result event is
  // skipped while a repaired/different one - including one that differs only
  // beyond maxToolResultChars - is still appended. Each fingerprint is O(1),
  // so retained memory does not grow with result size.
  // F3: each session keeps at most retainedCap fingerprints (FIFO window,
  // oldest evicted first) so memory cannot grow without bound.
  const seenResultsBySession = new Map();

  function sessionDir(sessionId) {
    return join(baseDir, safeSessionDirSegment(sessionId));
  }

  function ensureDir(target) {
    try {
      // F-6: the transcript store is the most sensitive artifact this plugin
      // writes; the session directory is owner-private (umask may only tighten).
      mkdirSync(target, { recursive: true, mode: 0o700 });
      return true;
    } catch (err) {
      safeLog(logger, 'warn', 'transcript: could not create session dir', {
        dir: target,
        error: errorText(err),
      });
      return false;
    }
  }

  function appendLine(path, line) {
    try {
      // F-6: mode applies only when the file is created; an existing transcript
      // keeps its mode. 0o600 is owner-readable/writable (umask may tighten).
      appendFileSync(path, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (err) {
      safeLog(logger, 'warn', 'transcript: write failed', {
        path,
        error: errorText(err),
      });
      return false;
    }
  }

  function seenFor(sessionId) {
    let seen = seenBySession.get(sessionId);
    if (!seen) {
      seen = new Set();
      seenBySession.set(sessionId, seen);
    }
    return seen;
  }

  function seenResultsFor(sessionId) {
    let seen = seenResultsBySession.get(sessionId);
    if (!seen) {
      // order is the FIFO window of {callId, fingerprint} in insertion order;
      // byCallId indexes the same fingerprints by tool_use_id for O(1) lookup.
      seen = { byCallId: new Map(), order: [] };
      seenResultsBySession.set(sessionId, seen);
    }
    return seen;
  }

  function pathFor(sessionId) {
    const target = sessionDir(sessionId);
    ensureDir(target);
    return join(target, 'transcript.jsonl');
  }

  function writerFor(sessionId) {
    const key = String(sessionId);
    const path = pathFor(key);
    const seen = seenFor(key);
    const seenResults = seenResultsFor(key);

    return {
      path,

      appendUser(text) {
        const content = typeof text === 'string' ? text : String(text ?? '');
        // Never emit a line whose mapped content is empty (image-only turns).
        if (content === '') return;
        appendLine(path, {
          type: 'message',
          message: { role: 'user', content },
        });
      },

      appendAssistant(blocks) {
        const list = Array.isArray(blocks) ? blocks : blocks == null ? [] : [blocks];
        const content = [];
        for (const block of list) {
          const mapped = mapBlock(block);
          if (!mapped) continue;
          if (mapped.type === 'tool_use' && mapped.id !== undefined && mapped.id !== null) {
            seen.add(mapped.id);
          }
          content.push(mapped);
        }
        if (content.length === 0) return; // nothing transcript-worthy
        appendLine(path, { type: 'message', message: { role: 'assistant', content } });
      },

      appendToolCall(call) {
        const { callId, name, arguments: args } = call || {};
        if (callId !== undefined && callId !== null && seen.has(callId)) return;
        if (callId !== undefined && callId !== null) seen.add(callId);
        // ASSISTANT role: ClawMem's extractors (precompact-extract.ts:74,
        // handoff-generator.ts:320) scan assistant content only, so a
        // synthesized tool_use must ride an assistant message to be seen.
        appendLine(path, {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: callId, name, input: parseArguments(args) }],
          },
        });
      },

      appendToolResult(result) {
        const { callId, content: raw, isError } = result || {};
        const fullText = toResultText(raw);
        const content = truncate(fullText, maxToolResultChars);
        const isErrorFlag = Boolean(isError);
        // ADV7-03: the transcript contract excludes empty content lines (README;
        // appendUser and the event path's mapped-empty skip enforce the same
        // invariant), so a result that stores nothing - an empty input, or a
        // non-empty input truncated to nothing at the documented-valid
        // maxToolResultChars: 0 - must not emit a line. This is also a direct-API
        // behaviour change: appendToolResult previously wrote content: '' here.
        // Return before the fingerprint so a result that produces no visible line
        // cannot occupy the de-duplication window and suppress a later real one.
        if (content === '') return;
        // ADV2-02: fingerprint the full text, not the truncated copy, so two
        // results for the same id that share the first maxToolResultChars
        // characters do not collide; the line still stores the truncated text.
        const fingerprint = toolResultFingerprint(fullText, isErrorFlag);
        if (callId !== undefined && callId !== null) {
          // Identical full-content re-delivery of the same tool result is
          // dropped; a repaired/different result for the same id - including
          // one that differs only past the truncation point or only in
          // is_error - is still appended.
          let fingerprints = seenResults.byCallId.get(callId);
          if (fingerprints && fingerprints.has(fingerprint)) return;
          if (!fingerprints) {
            fingerprints = new Set();
            seenResults.byCallId.set(callId, fingerprints);
          }
          fingerprints.add(fingerprint);
          seenResults.order.push({ callId, fingerprint });
          // F3: evict the oldest fingerprints once the window is full. Every
          // queued entry maps to a live fingerprint (duplicates return above),
          // so the window length is exactly the retained fingerprint count.
          while (seenResults.order.length > retainedCap) {
            const oldest = seenResults.order.shift();
            const remaining = seenResults.byCallId.get(oldest.callId);
            if (!remaining) continue;
            remaining.delete(oldest.fingerprint);
            if (remaining.size === 0) seenResults.byCallId.delete(oldest.callId);
          }
        }
        appendLine(path, {
          type: 'message',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: callId,
                content,
                is_error: isErrorFlag,
              },
            ],
          },
        });
      },
    };
  }

  /**
   * F-8 / ADV2-01: only a directory whose ENTIRE content inventory is this
   * plugin's own session artifacts is safe to delete recursively:
   *
   *   - a regular file named transcript.jsonl, and/or
   *   - a real directory named memory whose own entries are empty or only a
   *     regular file named precompact-state.md,
   *   - or a directory with no entries at all (a session that never wrote).
   *
   * Ownership is decided per entry, never by a marker's mere existence. Any
   * other entry - an extra or hidden file, a marker that is a symlink or a
   * directory, memory/ holding any other content, a memory that is not a real
   * directory - means foreign content is present, so the WHOLE directory is
   * kept (counted as kept) instead of deleted. A read failure here propagates
   * to sweep()'s per-entry catch (warn + errors), never to a delete.
   *
   * ADV-01: runPrecompact() calls ensurePrecompactMemoryDir() before the hook
   * runs, so a session whose precompaction failed/timed out (or that never wrote
   * a transcript line) can leave exactly one empty memory/ directory behind.
   * That is still this plugin's own session store - the pre-F-8 sweep removed it
   * - so it rotates like an empty directory.
   */
  function isOwnedRegularFile(entry, name) {
    // Dirent.isFile() is true only for a real regular file: a symlink (even one
    // pointing at a file), a directory, a FIFO or a socket does not qualify.
    return entry.name === name && entry.isFile();
  }

  function memoryDirIsOwned(target) {
    const entries = readdirSync(join(target, 'memory'), { withFileTypes: true });
    return entries.every((entry) => isOwnedRegularFile(entry, 'precompact-state.md'));
  }

  function isTranscriptSessionStore(target) {
    const entries = readdirSync(target, { withFileTypes: true });
    if (entries.length === 0) return true;
    return entries.every((entry) => {
      if (isOwnedRegularFile(entry, 'transcript.jsonl')) return true;
      // A symlink named memory is not the directory this plugin creates, so only
      // a real Dirent directory qualifies; its own inventory must be ours too.
      if (entry.name === 'memory' && entry.isDirectory()) return memoryDirIsOwned(target);
      return false;
    });
  }

  function sweep() {
    const summary = { removed: 0, kept: 0, errors: 0 };
    if (!rotationCfg.enabled) {
      safeLog(logger, 'debug', 'transcript: rotation disabled; sweep skipped', { dir: baseDir });
      return summary;
    }
    let entries;
    try {
      entries = readdirSync(baseDir, { withFileTypes: true });
    } catch (err) {
      // F-5: a fresh DSH_HOME has no transcript directory yet (ENOENT). That is
      // the normal empty directory, not a failure worth a warn on every first
      // boot. Every other errno is a real read failure and falls through to the
      // warn + errors count - notably ENOTDIR, which means transcript.dir (or a
      // path component) is a regular file and must be surfaced, not hidden.
      if (err && err.code === 'ENOENT') return summary;
      summary.errors += 1;
      safeLog(logger, 'warn', 'transcript: sweep could not read transcript dir', {
        dir: baseDir,
        error: errorText(err),
      });
      return summary;
    }

    // Normalised at construction (ADV5-03), so this is always a finite age.
    const maxAgeDays = rotationCfg.maxAgeDays;
    const cutoff = Date.now() - maxAgeDays * DAY_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // session subdirectories only
      const target = join(baseDir, entry.name);
      try {
        const newest = newestMtimeMs(target);
        if (newest >= cutoff) {
          summary.kept += 1;
          continue;
        }
        // F-8: an aged directory is only removable when it is one of our own
        // session stores; a foreign directory with other content is kept.
        if (!isTranscriptSessionStore(target)) {
          summary.kept += 1;
          continue;
        }
        rmSync(target, { recursive: true, force: true });
        summary.removed += 1;
        safeLog(logger, 'info', 'transcript: removed aged session transcript', {
          session: entry.name,
          ageDays: Math.round((Date.now() - newest) / DAY_MS),
        });
      } catch (err) {
        summary.errors += 1;
        safeLog(logger, 'warn', 'transcript: sweep failed for session dir', {
          session: entry.name,
          error: errorText(err),
        });
      }
    }

    safeLog(logger, 'info', 'transcript: rotation sweep complete', {
      dir: baseDir,
      removed: summary.removed,
      kept: summary.kept,
      errors: summary.errors,
      maxAgeDays,
      sweepIntervalHours: rotationCfg.sweepIntervalHours,
    });
    return summary;
  }

  function close() {
    // Synchronous appends hold no file handles; drop de-dupe state only.
    seenBySession.clear();
    seenResultsBySession.clear();
    safeLog(logger, 'debug', 'transcript: manager closed', { dir: baseDir });
  }

  /**
   * Test-only introspection of the bounded de-dupe state (F3): cap, retained
   * tool_use_ids and retained fingerprints for a session. Not part of the
   * supported API - the manager surface stays pathFor/writerFor/sweep/close.
   */
  function dedupeStats(sessionId) {
    const seen = seenResultsBySession.get(sessionId);
    return {
      cap: retainedCap,
      callIds: seen ? seen.byCallId.size : 0,
      fingerprints: seen ? seen.order.length : 0,
    };
  }

  return { pathFor, writerFor, sweep, close, __dedupeStats: dedupeStats };
}
