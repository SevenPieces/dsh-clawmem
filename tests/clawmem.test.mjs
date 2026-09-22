// tests/clawmem.test.mjs
// Transport contracts of lib/clawmem.js (runHook/parse/extract).
//
// Fix -> test map (round 3; keep this current so a revert audit is unambiguous):
//   F1  'logged' flag on the result -> "runHook reports 'logged' true for a failure
//       and an anomaly, false for a clean success" (dedicated; incl. the F7c stderr
//       cap anomaly and the non-zero exit).
//   F1  muted client, call site still warns (D-18) -> "a silenced client reports
//       logged false so the call site still warns".
//   F7c stderr bound + one cap log -> 'stderr accumulation is capped at maxOutputBytes
//       and logs the cap exactly once' (asserts r.stderr.length and exactly one cap
//       log; deliberately does NOT assert r.logged - see finding 2/round 3).
//   H6  transport anomalies -> empty stdout / invalid JSON / oversized stdout /
//       level 'off' / timeout / non-zero exit / signal tests below.
//   L5  (round 12) the last additionalContext-bearing JSON line wins -> 'L5: ...'
//       tests below (parseOutput/extractContext).
//   L6  (round 12) the timeout kills the whole process group -> "L6: a timeout
//       kills the forking wrapper and its grandchild" below (Linux-only).
//   L6c (round 15) the discriminating orphan case: a double-forked (reparented)
//       grandchild is reaped and both stdio pipes close -> "L6c: ..." below
//       (Linux-only). A non-detached /proc PPID walk fails this test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractContext, createClawmemClient, DEFAULT_MAX_OUTPUT_BYTES } from '../lib/clawmem.js'

const LF = String.fromCharCode(10)

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'clawmem-bin-'))
}

function writeBin(dir, file, bodyLines) {
  const bin = join(dir, file)
  writeFileSync(bin, ['#!/usr/bin/env node'].concat(bodyLines || []).join(LF) + LF)
  chmodSync(bin, 0o755)
  return bin
}

function recordingLogger() {
  const calls = []
  function record(level) {
    return function (message) { calls.push({ level: level, message: String(message) }) }
  }
  return { calls: calls, logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') } }
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }) }

const OK_BIN = ['process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX:" + process.argv[3] } }))']
const EMPTY_BIN = ['// writes nothing to stdout']
const INVALID_BIN = ['process.stdout.write("{not json")']
const ENV_BIN = ['process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: String(process.env.CLAWMEM_PROFILE) } }))']
const HANG_BIN = ['setTimeout(function () {}, 60000)']
const FAIL_BIN = ['process.stderr.write("fake failure detail")', 'process.exit(3)']
const SIGNAL_BIN = ['process.kill(process.pid, "SIGTERM")']

test('extractContext reads the last JSON line additionalContext', () => {
  const out = JSON.stringify({ hookSpecificOutput: { additionalContext: 'hello' } })
  assert.equal(extractContext(out), 'hello')
  assert.equal(extractContext('garbage'), '')
  assert.equal(extractContext(JSON.stringify({ continue: true })), '')
  assert.equal(extractContext('noise' + String.fromCharCode(10) + out), 'hello')
})

test('runHook returns ok and stdout for a fake bin, and fails open on a missing bin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawmem-bin-'))
  const bin = join(dir, 'fake.mjs')
  writeFileSync(bin, '#!/usr/bin/env node' + String.fromCharCode(10) + 'const name = process.argv[3]' + String.fromCharCode(10) + 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "CTX:" + name } }))' + String.fromCharCode(10))
  chmodSync(bin, 0o755)
  const logs = []
  const logger = { warn: (m) => logs.push(m) }
  const client = createClawmemClient({ bin: bin, logger: logger })
  const r = await client.runHook('context-surfacing', { prompt: 'x' })
  assert.equal(r.ok, true)
  assert.equal(extractContext(r.stdout), 'CTX:context-surfacing')
  const missing = createClawmemClient({ bin: join(dir, 'nope.mjs'), logger: logger })
  const bad = await missing.runHook('context-surfacing', {})
  assert.equal(bad.ok, false)
  assert.ok(logs.length > 0)
  rmSync(dir, { recursive: true, force: true })
})

// ---- H6 / L7 / M1 (transport): output anomalies, log gating, log content, profile ----

test('empty stdout logs exactly one warn and reports parseIssue empty', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'empty.mjs', EMPTY_BIN)
  const rec = recordingLogger()
  const client = createClawmemClient({ bin: bin, logger: rec.logger })
  const r = await client.runHook('session-bootstrap', { session_id: 'sess-empty' })
  assert.equal(r.parseIssue, 'empty')
  assert.equal(r.context, '')
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0].level, 'warn')
  assert.match(rec.calls[0].message, /session-bootstrap/)
  assert.match(rec.calls[0].message, /empty/i)
  cleanup(dir)
})

test('malformed JSON stdout logs exactly one warn and reports parseIssue invalid', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'invalid.mjs', INVALID_BIN)
  const rec = recordingLogger()
  const client = createClawmemClient({ bin: bin, logger: rec.logger })
  const r = await client.runHook('context-surfacing', { session_id: 'sess-invalid' })
  assert.equal(r.parseIssue, 'invalid')
  assert.equal(r.context, '')
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0].level, 'warn')
  assert.match(rec.calls[0].message, /context-surfacing/)
  assert.match(rec.calls[0].message, /invalid/i)
  cleanup(dir)
})

test('stdout above maxOutputBytes logs once, fails ok, flags oversized and caps the buffer', async () => {
  const dir = makeDir()
  const max = 1024
  const bin = writeBin(dir, 'big.mjs', ['process.stdout.write("x".repeat(4096))'])
  const rec = recordingLogger()
  const client = createClawmemClient({ bin: bin, logger: rec.logger, maxOutputBytes: max })
  const r = await client.runHook('context-surfacing', { session_id: 'sess-big' })
  assert.equal(r.oversized, true)
  assert.equal(r.ok, false)
  assert.equal(r.stdout.length, max)
  assert.equal(r.context, '')
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0].level, 'warn')
  assert.match(rec.calls[0].message, /exceeded/i)
  cleanup(dir)
})

test("level 'off' produces zero logger calls on success, timeout, non-zero exit and parse failure", async () => {
  const dir = makeDir()
  const cases = [
    { file: 'ok.mjs', lines: OK_BIN, timeout: 2000 },
    { file: 'invalid.mjs', lines: INVALID_BIN, timeout: 2000 },
    { file: 'hang.mjs', lines: HANG_BIN, timeout: 40 },
    { file: 'fail.mjs', lines: FAIL_BIN, timeout: 2000 }
  ]
  for (const c of cases) {
    const bin = writeBin(dir, c.file, c.lines)
    const rec = recordingLogger()
    const client = createClawmemClient({ bin: bin, logger: rec.logger, level: 'off' })
    await client.runHook('context-surfacing', { session_id: 'sess-off' }, c.timeout)
    assert.equal(rec.calls.length, 0, c.file + ' produced logger calls: ' + JSON.stringify(rec.calls))
  }
  await new Promise(function (resolve) { setTimeout(resolve, 150) })
  cleanup(dir)
})

test('logStderr controls whether captured stderr appears in the exit log', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'fail.mjs', FAIL_BIN)
  const withStderr = recordingLogger()
  const r1 = await createClawmemClient({ bin: bin, logger: withStderr.logger }).runHook('context-surfacing', { session_id: 'sess-stderr' })
  assert.equal(r1.stderr.includes('fake failure detail'), true)
  assert.equal(withStderr.calls.length, 1)
  assert.match(withStderr.calls[0].message, /fake failure detail/)
  const withoutStderr = recordingLogger()
  const r2 = await createClawmemClient({ bin: bin, logger: withoutStderr.logger, logStderr: false }).runHook('context-surfacing', { session_id: 'sess-stderr' })
  assert.equal(r2.stderr.includes('fake failure detail'), true)
  assert.equal(withoutStderr.calls.length, 1)
  assert.equal(withoutStderr.calls[0].message.includes('fake failure detail'), false)
  cleanup(dir)
})

test('a timeout logs exactly once with hook name, session id and elapsed duration', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'hang.mjs', HANG_BIN)
  const rec = recordingLogger()
  const client = createClawmemClient({ bin: bin, logger: rec.logger })
  const r = await client.runHook('context-surfacing', { session_id: 'sess-timeout-42' }, 40)
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(rec.calls.length, 1)
  assert.match(rec.calls[0].message, /context-surfacing/)
  assert.match(rec.calls[0].message, /sess-timeout-42/)
  assert.match(rec.calls[0].message, /after [0-9]+ms/)
  await new Promise(function (resolve) { setTimeout(resolve, 200) })
  assert.equal(rec.calls.length, 1, 'timeout must not log a second time when close lands: ' + JSON.stringify(rec.calls))
  cleanup(dir)
})

test('a non-zero exit logs the exit code, and the signal when the close event carries one', async () => {
  const dir = makeDir()
  const exitRec = recordingLogger()
  const failBin = writeBin(dir, 'fail.mjs', FAIL_BIN)
  const r1 = await createClawmemClient({ bin: failBin, logger: exitRec.logger }).runHook('context-surfacing', { session_id: 'sess-exit' })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 3)
  assert.equal(r1.signal, null)
  assert.equal(exitRec.calls.length, 1)
  assert.match(exitRec.calls[0].message, /code=3/)
  assert.match(exitRec.calls[0].message, /sess-exit/)
  const sigRec = recordingLogger()
  const sigBin = writeBin(dir, 'sig.mjs', SIGNAL_BIN)
  const r2 = await createClawmemClient({ bin: sigBin, logger: sigRec.logger }).runHook('context-surfacing', { session_id: 'sess-sig' })
  assert.equal(r2.ok, false)
  assert.equal(r2.signal, 'SIGTERM')
  assert.equal(sigRec.calls.length, 1)
  assert.match(sigRec.calls[0].message, /SIGTERM/)
  cleanup(dir)
})

test("profile 'deep' reaches the child as CLAWMEM_PROFILE", async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'env.mjs', ENV_BIN)
  const deep = await createClawmemClient({ bin: bin, logger: recordingLogger().logger, profile: 'deep' }).runHook('context-surfacing', {})
  assert.equal(deep.context, 'deep')
  const none = await createClawmemClient({ bin: bin, logger: recordingLogger().logger }).runHook('context-surfacing', {})
  assert.equal(none.context, 'undefined')
  cleanup(dir)
})

test('stdout exactly at maxOutputBytes is not oversized; one byte over is', async () => {
  const dir = makeDir()
  const max = 2048
  const exactBin = writeBin(dir, 'exact.mjs', ['process.stdout.write("y".repeat(' + max + '))'])
  const exact = await createClawmemClient({ bin: exactBin, logger: recordingLogger().logger, maxOutputBytes: max }).runHook('context-surfacing', {})
  assert.equal(exact.oversized, false)
  assert.equal(exact.stdout.length, max)
  const overBin = writeBin(dir, 'over.mjs', ['process.stdout.write("y".repeat(' + (max + 1) + '))'])
  const over = await createClawmemClient({ bin: overBin, logger: recordingLogger().logger, maxOutputBytes: max }).runHook('context-surfacing', {})
  assert.equal(over.oversized, true)
  assert.equal(over.stdout.length, max)
  cleanup(dir)
})

test('runHook exposes the frozen result fields and the default output cap', async () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1048576)
  const dir = makeDir()
  const bin = writeBin(dir, 'ok.mjs', OK_BIN)
  const r = await createClawmemClient({ bin: bin, logger: recordingLogger().logger }).runHook('context-surfacing', { session_id: 'sess-shape' })
  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.signal, null)
  assert.equal(r.timedOut, false)
  assert.equal(r.oversized, false)
  assert.equal(r.parseIssue, null)
  assert.equal(r.context, 'CTX:context-surfacing')
  assert.equal(typeof r.ms, 'number')
  assert.equal(extractContext(r.stdout), r.context)
  cleanup(dir)
})

test('a throwing logger never breaks a hook run', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'invalid.mjs', INVALID_BIN)
  const logger = { warn: function () { throw new Error('logger exploded') }, error: function () { throw new Error('logger exploded') } }
  const r = await createClawmemClient({ bin: bin, logger: logger }).runHook('context-surfacing', { session_id: 'sess-throw' })
  assert.equal(r.parseIssue, 'invalid')
  cleanup(dir)
})

// ---- F1 / F7c (round 2): the 'logged' flag and the stderr cap ----

test("runHook reports 'logged' true for a failure and an anomaly, false for a clean success", async () => {
  const dir = makeDir()
  const okBin = writeBin(dir, 'ok.mjs', OK_BIN)
  const ok = await createClawmemClient({ bin: okBin, logger: recordingLogger().logger }).runHook('context-surfacing', { session_id: 'sess-logged' })
  assert.equal(ok.ok, true)
  assert.equal(ok.logged, false, 'a clean success must not claim the client logged anything')
  const emptyBin = writeBin(dir, 'empty.mjs', EMPTY_BIN)
  const empty = await createClawmemClient({ bin: emptyBin, logger: recordingLogger().logger }).runHook('session-bootstrap', { session_id: 'sess-logged' })
  assert.equal(empty.parseIssue, 'empty')
  assert.equal(empty.logged, true, 'the client logged the empty-stdout anomaly itself')
  const failBin = writeBin(dir, 'fail.mjs', FAIL_BIN)
  const fail = await createClawmemClient({ bin: failBin, logger: recordingLogger().logger }).runHook('context-surfacing', { session_id: 'sess-logged' })
  assert.equal(fail.ok, false)
  assert.equal(fail.logged, true, 'the client logged the non-zero exit itself')
  const hangBin = writeBin(dir, 'hang.mjs', HANG_BIN)
  const hang = await createClawmemClient({ bin: hangBin, logger: recordingLogger().logger }).runHook('context-surfacing', { session_id: 'sess-logged' }, 60)
  assert.equal(hang.timedOut, true)
  assert.equal(hang.logged, true, 'the client logged the timeout itself')
  // F7c's stderr cap is another anomaly the client logs itself. It is asserted
  // HERE, in the dedicated 'logged' test, so that reverting the F1 'logged' field
  // cannot fail the F7c cap detection (finding 2, round 3).
  const chattyBin = writeBin(dir, 'chatty-logged.mjs', [
    'process.stderr.write("e".repeat(4096))',
    'process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "ok" } }))'
  ])
  const chatty = await createClawmemClient({ bin: chattyBin, logger: recordingLogger().logger, maxOutputBytes: 1024 }).runHook('context-surfacing', { session_id: 'sess-logged' })
  assert.equal(chatty.ok, true)
  assert.equal(chatty.logged, true, 'the client logged the stderr cap itself')
  await new Promise(function (resolve) { setTimeout(resolve, 150) })
  cleanup(dir)
})

test("a silenced client reports logged false so the call site still warns (D-18)", async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'hang.mjs', HANG_BIN)
  const rec = recordingLogger()
  const r = await createClawmemClient({ bin: bin, logger: rec.logger, level: 'off' }).runHook('context-surfacing', { session_id: 'sess-mute' }, 60)
  assert.equal(r.timedOut, true)
  assert.equal(r.logged, false, 'nothing was emitted, so nothing was logged')
  assert.equal(rec.calls.length, 0)
  await new Promise(function (resolve) { setTimeout(resolve, 150) })
  cleanup(dir)
})

test('stderr accumulation is capped at maxOutputBytes and logs the cap exactly once', async () => {
  const dir = makeDir()
  const max = 1024
  const bin = writeBin(dir, 'chatty.mjs', [
    'process.stderr.write("e".repeat(4096))',
    'process.stderr.write("f".repeat(4096))',
    'process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "ok" } }))'
  ])
  const rec = recordingLogger()
  const r = await createClawmemClient({ bin: bin, logger: rec.logger, maxOutputBytes: max }).runHook('context-surfacing', { session_id: 'sess-chatty' })
  assert.equal(r.ok, true)
  assert.equal(r.stderr.length, max, 'stderr is capped like stdout, not accumulated in full')
  assert.equal(rec.calls.length, 1, 'exactly one cap log: ' + JSON.stringify(rec.calls))
  assert.equal(rec.calls[0].level, 'warn')
  assert.match(rec.calls[0].message, /stderr/)
  // F7c is detected here by the two cap assertions above (r.stderr.length === max and
  // exactly one cap log). The 'logged' flag for this same cap is asserted in the
  // dedicated 'logged' test instead, so reverting the F1 'logged' field fails only
  // that test and leaves F7c detection independent (finding 2, round 3).
  cleanup(dir)
})

// ---- L5 (round 12): a trailing context-free JSON line must not discard an
// earlier hookSpecificOutput.additionalContext. parseOutput keeps the LAST
// parseable JSON line today, so the earlier context is silently lost ('' with
// no log line). The fix scans every parseable line and keeps the last one that
// actually carries a string additionalContext; '' stdout stays 'empty' and
// stdout with no parseable JSON line stays 'invalid' (covered by the existing
// 'empty stdout ...' and 'malformed JSON stdout ...' tests above).

const L5_CONTEXT_LINE = JSON.stringify({ hookSpecificOutput: { additionalContext: 'kept' } })
const L5_PLAIN_JSON_LINE = JSON.stringify({ continue: true })
const L5_DIAGNOSTIC_LINE = 'clawmem: trailing non-JSON diagnostic'

test('L5: extractContext keeps an earlier additionalContext when a later JSON line carries none', () => {
  assert.equal(extractContext(L5_CONTEXT_LINE + LF + L5_PLAIN_JSON_LINE), 'kept')
  // regression: a non-JSON diagnostic line after the context line
  assert.equal(extractContext(L5_CONTEXT_LINE + LF + L5_DIAGNOSTIC_LINE), 'kept')
  // no context anywhere -> '' (unchanged)
  assert.equal(extractContext(L5_PLAIN_JSON_LINE), '')
  assert.equal(extractContext(''), '')
})

test('L5: runHook returns the earlier context and stays quiet when a later JSON line carries none', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'ctx-then-plain.mjs', [
    'process.stdout.write(' + JSON.stringify(L5_CONTEXT_LINE + LF + L5_PLAIN_JSON_LINE) + ')'
  ])
  const rec = recordingLogger()
  const r = await createClawmemClient({ bin: bin, logger: rec.logger }).runHook('context-surfacing', { session_id: 'sess-l5' })
  assert.equal(r.ok, true)
  assert.equal(r.parseIssue, null)
  assert.equal(r.context, 'kept', 'the earlier additionalContext must survive a later context-free JSON line')
  assert.equal(r.logged, false)
  assert.equal(rec.calls.length, 0, 'a clean context-bearing run logs nothing: ' + JSON.stringify(rec.calls))
  assert.equal(extractContext(r.stdout), 'kept')
  cleanup(dir)
})

test('L5: valid JSON without any additionalContext keeps parseIssue null and context empty', async () => {
  const dir = makeDir()
  const bin = writeBin(dir, 'plain.mjs', ['process.stdout.write(' + JSON.stringify(L5_PLAIN_JSON_LINE) + ')'])
  const rec = recordingLogger()
  const r = await createClawmemClient({ bin: bin, logger: rec.logger }).runHook('context-surfacing', { session_id: 'sess-l5-plain' })
  assert.equal(r.ok, true)
  assert.equal(r.parseIssue, null)
  assert.equal(r.context, '')
  assert.equal(rec.calls.length, 0)
  cleanup(dir)
})

// ---- L6 (round 12): the timeout must kill the whole process group, not only
// the direct child. The real clawmem bin ends in exec so it leaves no orphan,
// but a forking wrapper leaves a grandchild holding both stdio pipes (libuv
// handles stay alive). spawn() is now detached (own group leader) and the
// timeout SIGKILLs -pid with a fallback to child.kill('SIGKILL').

/** Linux/POSIX: is the pid still a live (non-zombie) process? */
function processRunning(pid) {
  if (!pid) return false
  try { process.kill(pid, 0) } catch (error) { return error.code === 'EPERM' }
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0)
    return state !== 'Z' && state !== 'X'
  } catch (error) {
    return error.code !== 'ENOENT'
  }
}

/** Linux: the ppid column of /proc/<pid>/stat, or null when unreadable. */
function ppidOf(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  } catch (error) { return null }
}

/** Linux: node's stdio 'pipe' endpoints are AF_UNIX sockets, named "socket:[N]". */
const STDIO_SOCKET = /^socket:\[([0-9]+)\]$/

/**
 * Linux: which of these inherited stdio endpoints is still held by any process?
 * /proc/net/unix lists every live AF_UNIX endpoint in the namespace, so an
 * endpoint disappearing from that table means every copy of the child's write
 * end is closed - the condition that lets libuv close the stream (and the hook
 * lane) instead of hanging.
 *
 * Deliberately NOT a /proc/<pid>/fd walk: with the kernel's Yama
 * ptrace_scope=1, /proc/<pid>/fd of a reparented survivor is unreadable (it is
 * no longer a descendant), so a walk silently reports "nothing held" for
 * exactly the orphan this test is about - measured: the walk returned no
 * holders while the survivor was alive and its fd 1 was the recorded endpoint.
 */
function stdioEndpointsHeld(endpoints) {
  const wanted = new Set()
  for (const endpoint of endpoints || []) {
    const match = typeof endpoint === 'string' ? STDIO_SOCKET.exec(endpoint) : null
    if (match) wanted.add(match[1])
  }
  const held = []
  if (wanted.size === 0) return held
  const table = readFileSync('/proc/net/unix', 'utf8').split(LF)
  for (const line of table) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 7) continue
    if (wanted.has(columns[6])) held.push('socket:[' + columns[6] + ']')
  }
  return held
}

test('L6: a timeout kills the forking wrapper and its grandchild', { skip: process.platform === 'linux' ? false : 'POSIX process groups required' }, async () => {
  const dir = makeDir()
  const pidFile = join(dir, 'pids.json')
  const bin = writeBin(dir, 'forker.mjs', [
    "import { spawn } from 'node:child_process'",
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "function pgrpOf(pid) { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) }",
    "const gc = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], { stdio: 'inherit' })",
    'writeFileSync(' + JSON.stringify(pidFile) + ', JSON.stringify({ wrapper: process.pid, grandchild: gc.pid, wrapperGroup: pgrpOf(process.pid), grandchildGroup: pgrpOf(gc.pid) }))',
    'setTimeout(function () {}, 60000)'
  ])
  const rec = recordingLogger()
  const client = createClawmemClient({ bin: bin, logger: rec.logger })
  const started = Date.now()
  const running = client.runHook('context-surfacing', { session_id: 'sess-l6' }, 600)
  let pids = null
  while (Date.now() - started < 5000) {
    try { pids = JSON.parse(readFileSync(pidFile, 'utf8')) } catch { pids = null }
    if (pids && pids.grandchild) break
    await new Promise(function (resolve) { setTimeout(resolve, 25) })
  }
  const r = await running
  try {
    assert.ok(pids && pids.grandchild, 'the wrapper never reported its grandchild pid')
    assert.equal(pids.wrapperGroup, pids.wrapper, 'the spawned child must be its own group leader (detached: true)')
    assert.equal(pids.grandchildGroup, pids.wrapper, 'the forked grandchild must share that process group')
    assert.equal(r.timedOut, true)
    assert.equal(r.ok, false)
    assert.equal(rec.calls.length, 1, 'exactly one timeout log: ' + JSON.stringify(rec.calls))
    const deadline = Date.now() + 4000
    for (const pid of [pids.wrapper, pids.grandchild]) {
      while (processRunning(pid) && Date.now() < deadline) await new Promise(function (resolve) { setTimeout(resolve, 25) })
      assert.equal(processRunning(pid), false, 'pid ' + pid + ' survived the timeout group kill')
    }
  } finally {
    for (const pid of [pids && pids.wrapper, pids && pids.grandchild]) {
      if (pid && processRunning(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
    }
    cleanup(dir)
  }
})

// L6b: the required fallback. When the group signal itself fails (ESRCH/EPERM,
// or a NaN pid), the timeout must still SIGKILL the direct child. process.kill is
// patched only for the duration of this test to make the group signal throw; the
// patch is restored in a finally. This locks the fallback branch: a regression to
// "group kill only" leaves the child alive and fails here.
test('L6: a failing group signal still kills the direct child', { skip: process.platform === 'linux' ? false : 'POSIX process groups required' }, async () => {
  const dir = makeDir()
  const pidFile = join(dir, 'child.pid')
  const bin = writeBin(dir, 'hang-pid.mjs', [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid))',
    'setTimeout(function () {}, 60000)'
  ])
  const rec = recordingLogger()
  const realKill = process.kill
  let childPid = null
  process.kill = function (pid, signal) {
    if (pid < 0) { const error = new Error('kill ESRCH'); error.code = 'ESRCH'; throw error }
    return realKill.call(process, pid, signal)
  }
  let survived = true
  try {
    const started = Date.now()
    const running = createClawmemClient({ bin: bin, logger: rec.logger }).runHook('context-surfacing', { session_id: 'sess-l6-fallback' }, 600)
    while (Date.now() - started < 5000) {
      try { childPid = Number(readFileSync(pidFile, 'utf8')) } catch { childPid = null }
      if (childPid) break
      await new Promise(function (resolve) { setTimeout(resolve, 25) })
    }
    const r = await running
    assert.ok(childPid, 'the child never reported its pid')
    assert.equal(r.timedOut, true)
    assert.equal(rec.calls.length, 1, 'exactly one timeout log: ' + JSON.stringify(rec.calls))
    const deadline = Date.now() + 2500
    while (processRunning(childPid) && Date.now() < deadline) await new Promise(function (resolve) { setTimeout(resolve, 25) })
    // Sampled BEFORE the finally cleanup below, so a regression to "group kill
    // only" (fallback dropped) leaves survived true and fails here.
    survived = processRunning(childPid)
  } finally {
    process.kill = realKill
    if (childPid && processRunning(childPid)) { try { realKill.call(process, childPid, 'SIGKILL') } catch { /* ignore */ } }
    cleanup(dir)
  }
  assert.equal(survived, false, 'a failed group signal must fall back to killing the direct child')
})

// L6c (round 15): the discriminating case for the L6 mechanism, and the reason
// the group kill must never be replaced by a /proc PPID walk. The wrapper
// double-forks: it spawns an intermediate which spawns the long-lived grandchild
// (inheriting both stdio pipes) and then exits, so the grandchild reparents to
// init and is unreachable from the direct child's PPID chain. detached:true still
// reaches it because it shares the direct child's process group. Measured by the
// round-14 verifier with the same double-fork fixture: detached + kill(-pid)
// reaps 3/3 runs, the /proc PPID walk leaks 3/3 (pipes never close).
test('L6c: a timeout reaps a double-forked grandchild and closes both stdio pipes', { skip: process.platform === 'linux' ? false : 'POSIX process groups and /proc required' }, async () => {
  const dir = makeDir()
  const treeFile = join(dir, 'tree.json')
  // The intermediate, run with 'node -e' (argv[1] is the first user argument):
  // fork the grandchild, record the tree and the inherited stdio endpoints
  // (pipe or socketpair inode, per /proc), then exit immediately so the
  // grandchild reparents to init.
  const intermediate = [
    "const { spawn } = require('node:child_process')",
    "const { readlinkSync, writeFileSync } = require('node:fs')",
    'const wrapperPid = Number(process.argv[1])',
    'const treeFile = String(process.argv[2])',
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 600000)'], { stdio: 'inherit' })",
    "const inode = function (fd) { try { return readlinkSync('/proc/self/fd/' + fd) } catch (error) { return null } }",
    'writeFileSync(treeFile, JSON.stringify({ wrapper: wrapperPid, intermediate: process.pid, grandchild: grandchild.pid, stdio: [inode(1), inode(2)] }))',
    'grandchild.unref()',
    'process.exit(0)'
  ].join(String.fromCharCode(10))
  const bin = writeBin(dir, 'double-forker.mjs', [
    "import { spawn } from 'node:child_process'",
    'const intermediate = ' + JSON.stringify(intermediate),
    "spawn(process.execPath, ['-e', intermediate, String(process.pid), " + JSON.stringify(treeFile) + "], { stdio: 'inherit' })",
    'setTimeout(function () {}, 60000)'
  ])
  const rec = recordingLogger()
  const client = createClawmemClient({ bin: bin, logger: rec.logger })
  const started = Date.now()
  const running = client.runHook('context-surfacing', { session_id: 'sess-l6c' }, 1200)
  let tree = null
  while (Date.now() - started < 5000) {
    try { tree = JSON.parse(readFileSync(treeFile, 'utf8')) } catch (error) { tree = null }
    if (tree && tree.grandchild) break
    await new Promise(function (resolve) { setTimeout(resolve, 25) })
  }
  // Sample the reparenting BEFORE the timeout kill: a single-fork fixture would
  // still report the wrapper (or the live intermediate) as the grandchild's ppid.
  let grandchildPpid = null
  if (tree && tree.grandchild) {
    const reparentDeadline = Date.now() + 4000
    while (Date.now() < reparentDeadline) {
      grandchildPpid = ppidOf(tree.grandchild)
      if (grandchildPpid !== null && grandchildPpid !== tree.wrapper && grandchildPpid !== tree.intermediate) break
      await new Promise(function (resolve) { setTimeout(resolve, 25) })
    }
  }
  const r = await running
  try {
    assert.ok(tree && tree.grandchild, 'the double-forker never reported its grandchild pid')
    assert.notEqual(grandchildPpid, tree.wrapper, 'the grandchild must reparent off the direct child (double fork, not single)')
    assert.notEqual(grandchildPpid, tree.intermediate, 'the grandchild must reparent off the intermediate (double fork, not single)')
    assert.equal(r.timedOut, true)
    assert.equal(r.ok, false)
    assert.equal(rec.calls.length, 1, 'exactly one timeout log: ' + JSON.stringify(rec.calls))
    assert.match(rec.calls[0].message, /timed out after/)
    // The endpoint evidence must be real: without both inherited endpoints named,
    // the closure assertion below would pass vacuously.
    assert.equal(tree.stdio.filter(function (p) { return typeof p === 'string' && STDIO_SOCKET.test(p) }).length, 2, 'both inherited stdio endpoints must be identified as AF_UNIX sockets (libuv on Linux): ' + JSON.stringify(tree.stdio))
    // Wrapper and grandchild gone, and - the discriminating half - every copy of
    // the child's stdio write ends closed. A reparented grandchild left alive by a
    // PPID-walk kill shows up in both (its death never happens, its endpoints stay
    // in /proc/net/unix, and the client's hook lane would hang).
    const deadline = Date.now() + 4000
    const survivors = []
    for (const pid of [tree.wrapper, tree.grandchild]) {
      while (processRunning(pid) && Date.now() < deadline) await new Promise(function (resolve) { setTimeout(resolve, 25) })
      if (processRunning(pid)) survivors.push(pid)
    }
    const closeDeadline = Date.now() + 1500
    let held = stdioEndpointsHeld(tree.stdio)
    while (held.length > 0 && Date.now() < closeDeadline) {
      await new Promise(function (resolve) { setTimeout(resolve, 25) })
      held = stdioEndpointsHeld(tree.stdio)
    }
    assert.deepEqual(survivors, [], 'pids still alive after the timeout group kill (stdio endpoints still held: ' + JSON.stringify(held) + ')')
    assert.deepEqual(held, [], 'the inherited stdio endpoints are still held open after the timeout')
  } finally {
    for (const pid of [tree && tree.wrapper, tree && tree.grandchild]) {
      if (pid && processRunning(pid)) { try { process.kill(pid, 'SIGKILL') } catch (error) { /* ignore */ } }
    }
    cleanup(dir)
  }
})

