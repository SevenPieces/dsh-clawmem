# dsh-clawmem

Out-of-tree DSH Cordis bundle that gives ClawMem full parity with its
Claude Code / OpenClaw / Hermes integrations, plus the companion MCP client row that exposes
ClawMem's `mcp__clawmem__*` tools.

Tested with dsh-v0.2.1-rc.2 and ClawMem 0.24.0.

## Purpose

One ESM Cordis plugin (`lib/index.js`) that:

- surfaces relevant vault context automatically on prompt (`agent/pre-step`, `context-surfacing`)
  whenever the prompt is at least `surfacing.minPromptChars` long;
- runs `session-bootstrap`, `curator-nudge`, and `staleness-check` once at session start;
- captures pre-compaction state before summarization and re-injects authoritative post-compaction
  context (the pending flag is cleared only after a successful `postcompact-inject`);
- runs throttled **per-turn** extraction (`decision-extractor`, `handoff-generator`,
  `feedback-loop`) detached, never blocking the turn;
- maintains a ClawMem-readable transcript per session;
- registers the `clawmem` skill and injects the DSH-adapted always-on routing block as a
  system-prompt section through `ctx.systemPrompt.section` (`systemPrompt` is declared in
  `inject`);
- ships a bundle patch that inserts the `@deepseek-ai/dsh-mcp-client` row for the ClawMem MCP
  server.

Architecture: hooks (automatic, ~90%) + MCP tools (explicit, ~10%). No DSH core changes; the
only DSH module import (`createUserMessage` from `@deepseek-ai/dsh-llm`) is loaded through
`lib/dsh-resolve.js` via an anchored `createRequire` so out-of-tree code never needs bare
`@deepseek-ai/*` resolution.

## Install

There is no published npm package yet: `npm view dsh-clawmem` returns 404, so adding the bare
name `dsh-clawmem` cannot resolve a registry copy. The working install today is the local
checkout (also the form used during development):

```bash
dsh plugin --profile web add "$HOME/.dsh/plugins/dsh-clawmem"
```

The package's `files` allowlist (`package.json`) ships `lib/`, `routing-block.dsh.md`,
`cordis.patch.yml` and `README.md`; npm adds `package.json` and `LICENSE` automatically, and
`tests/` is not shipped. Once the package is published, `dsh plugin --profile web add dsh-clawmem`
becomes the registry install path.

The CLI reconciles a `dsh.bundle` dependency into `dsh.profile.bundles` using the bundle patch
declared in `package.json` (`dsh.bundle.patch: ./cordis.patch.yml`). Restart `dsh-web.service`
after adding the package; the profile patch alone can hot-reload, but plugin `lib/` code does
not (see [Runbook](#runbook)).

Verify:

```bash
dsh --profile web --dump-config | grep -E 'clawmem|mcp'
```

## Bundle patch

`cordis.patch.yml` is a single insert with two rows: the MCP client row
(`memory-clawmem` -> `@deepseek-ai/dsh-mcp-client`, `serverName: clawmem`, stdio transport,
`args: ['mcp']`, `cwd: !!js "process.cwd()"`) and the plugin row (`dsh-clawmem`). The MCP row's
`command` ships **no machine path**: it is a `!!js` expression the loader evaluates at mount time,
which resolves to `$CLAWMEM_BIN` when set, else `$HOME/.npm-global/bin/clawmem`, and to the bare name
`clawmem` when `$HOME` is unset.

Note the asymmetry with the hook client documented below: **this expression cannot search `PATH`**, so
on a host whose `clawmem` is on `PATH` but not under `$HOME/.npm-global` the MCP row and the hook
client resolve *different* binaries - the MCP server would then fail to spawn while the hooks keep
working. The reverse case is just as real: when an *older* `clawmem` is on `PATH` while the correct
one sits under `$HOME/.npm-global`, the hooks and the MCP server run **two different binaries in the
same session**. The plugin's own config is not visible to this row either. Set `CLAWMEM_BIN` (and, if
you like, an explicit `clawmemBin` with the same value) so both agree. Config expressions are
evaluated once per boot, so changing one needs a restart, not a live reload.

## Runbook

### Plugin code changes need a service restart

`patchReload: live` — set for this profile in `~/.dsh/profiles/web/package.json`, and defined
by DSH as "watch the profile's user patch files after boot" — re-applies the **profile patch
layer** (`~/.dsh/profiles/web/cordis.patch.yml`) without a restart. It does **not** re-import
plugin code. The `dsh-clawmem` row is inserted by the package's own **bundle patch**
(`cordis.patch.yml`, named by `dsh.bundle.patch` in `package.json`), and `lib/*.js` is read
once when the process starts, so editing the file on disk does not replace the module already
in memory. A session started after an on-disk `lib/` edit therefore keeps running the module the process loaded at boot. **Any change under `lib/` therefore needs a
`dsh-web.service` restart.** Only edits to the profile patch layer are covered by the live reload.

To tell the two layers apart when a change seems not to take effect: the profile patch is
`~/.dsh/profiles/web/cordis.patch.yml`, while the plugin's row is declared in the package's
`cordis.patch.yml` (both rows are shown under [Bundle patch](#bundle-patch)).

### Tests

```bash
cd "$HOME/.dsh/plugins/dsh-clawmem" && node --test tests/*.test.mjs
```

The runner prints the authoritative count on its `ℹ tests` line - read that line rather than
trusting a number in prose (the suite targets Node 22 or newer). There is no CI wiring, so run this one-liner after any change. `tests/` is intentionally **not** part of the
package (see `files` in `package.json`), so this command and the `npm test` script are for a source
checkout; an installed copy carries no tests to run. `lib/index.js` also exports two internal seams -
`unavailableClient` and `createHookClient` - used by the fallback path and its tests; they are not a
public API and may change without notice.

Three of the guards need a tool the rest of the suite does not: `git` (the repository-ignore checks),
`npm` (the packed-file list) and a resolvable `js-yaml` (the loader-dialect layer). A missing one now
**fails** the run instead of skipping, because each is the strongest check of its kind; set
`DSH_CLAWMEM_ALLOW_NO_GIT=1`, `DSH_CLAWMEM_ALLOW_NO_NPM=1` or `DSH_CLAWMEM_ALLOW_NO_YAML=1` to turn
that specific failure into a reported skip when the environment genuinely cannot provide the tool.

## Configuration reference

Every value below is the code's actual default and is read from the Cordis plugin config at
activation; a malformed value is repaired to that default and logged at warn (fail-open).

`clawmemBin` has no absolute default: it is resolved once at startup, first hit wins - an explicit
`clawmemBin` from the config, then `$CLAWMEM_BIN`, then the first **regular executable file** named
`clawmem` on `PATH` (a directory of that name is not a binary), then `$HOME/.npm-global/bin/clawmem`,
and if none of those qualifies the bare name `clawmem` is kept so the spawn can still resolve it
against the child's own `PATH`. The only inputs are the config and the process environment
(`$HOME`, `$PATH`, `$CLAWMEM_BIN`), so no machine path is baked into the source; leading and
trailing whitespace is trimmed. A bare-name fallback cannot be turned into a package root: the skill
is registered only when the resolved value is path-shaped and resolves to a **regular file**, so a
directory, a missing path or a bare name skips registration with a warning instead of deriving a
package root from whatever happens to sit beside the process. The DSH profile anchor used for module
resolution (`lib/dsh-resolve.js`) does fall back to `os.homedir()`; the binary chain above does not.
Pin an explicit value when the binary lives somewhere unusual.

```yaml
clawmemBin: null                                   # auto-resolved, see above
profile: balanced                                  # speed | balanced | deep; forwarded to the
                                                   # ClawMem child as CLAWMEM_PROFILE
logging:
  level: warn            # off | error | warn | debug; debug also enables info
                         # gates the plugin's own lines and the stderr sink
  logHookStderr: true    # include captured stderr text in the non-zero-exit log
                         # (stderr is always captured, whatever this flag says)
surfacing:
  enabled: true
  timeoutMs: 2000                                  # fail-open, logged
  minPromptChars: 20
bootstrap:
  sessionBootstrap: true
  curatorNudge: true
  stalenessCheck: true
precompact:
  enabled: true
  # FIRE when the projected token count >= proximityRatio * compactionTriggerTokens,
  # where compactionTriggerTokens = compactionThresholdRatio * contextWindow; in the
  # raw-state fallback pressureTokens is the proxy for the missing projection.
  proximityRatio: 0.8
  compactionThresholdRatio: 0.8   # mirror of compaction-basic thresholdRatio; best-effort auto-read
  fallbackTriggerTokens: 100000   # floor; used only when no usable contextWindow is available
  fallbackOnCompactionStart: true
  timeoutMs: 5000                 # spawn timeout for precompact-extract
postcompact:
  enabled: true
extraction:
  enabled: true
  timeoutMs: 30000
  minIntervalMs: 10000           # per session
  coalesce: true                 # schedule one follow-up run after an in-flight run;
                                 # false drops the turn instead of queueing it
  maxConcurrentJobs: 1           # global cap on in-flight extraction runs
  minNewMessages: 2
  forceBeforeCompaction: true    # ignore minIntervalMs while the precompact gate has fired: every
                                 # pre-step above the gate re-arms it, disabling the throttle for the
                                 # whole above-gate period (one extraction per completed turn)
  hooks: [decision-extractor, handoff-generator, feedback-loop]
subagents:
  policy: exclude                # exclude | extract | full
transcript:
  dir: null                      # default: <DSH_HOME>/clawmem-transcripts, resolved at
                                 # activation; `~` is NOT expanded, so write an absolute
                                 # path if you set this
  rotation:
    enabled: true
    maxAgeDays: 180
    sweepIntervalHours: 24
  maxToolResultChars: 500
skill:
  register: true
  name: clawmem
routingBlock:
  mode: section                  # section | off
```

The hook transport caps each hook's stdout **and its captured stderr** at
`DEFAULT_MAX_OUTPUT_BYTES` — the client's `maxOutputBytes` option, default 1,048,576 bytes —
so a chatty child cannot grow the run's memory without bound. Hitting the cap is logged once
(the stdout notice rides the successful-exit path, the stderr notice is emitted as soon as the
cap is hit). The plugin never overrides that option, so the cap is a fixed limit in
`lib/clawmem.js` and not a plugin config key.

### Pre-compaction gate

The gate reads the client-visible projection view first
(`ctx.sessionProjections.snapshot(session).values.contextPressure`) and falls back to
`stateOf(session, 'contextPressure')` when the snapshot carries no such view, because the raw
state has no `projectedTokens`. With `proximityRatio: 0.8` the hook fires at **80% of the
DSH compaction threshold**, i.e. `0.8 * (0.8 * contextWindow) = 0.64 * contextWindow` under
`@deepseek-ai/dsh-compaction-basic` defaults, on `projectedTokens` (or on the `pressureTokens`
proxy when the raw-state fallback is in use). The real threshold
ratio is read best-effort from the compaction loader entry; `compactionThresholdRatio` is the
mirror fallback.

`gatePlan` in `lib/index.js` normalizes the view and selects the rule the gate will really apply: with a usable `contextWindow` the window-scaled ratio is used, and a raw `stateOf` fallback
- which carries `contextWindow` and `pressureTokens` but no `projectedTokens` - is scaled with
`pressureTokens` as the best available proxy, instead of falling to the 100000 floor at 13% of a
1M window. The `fallbackTriggerTokens` floor applies only when no usable `contextWindow` is
available (an accepted fallback), and a view with no metric at all does not fire. The debug line
names the branch, the rule, the metric and the real threshold, so it can no longer print a
threshold the gate did not use. Over-firing is safe: `precompact-extract` is regex-only and
idempotent. Each firing is still an awaited subprocess, and whether to rate-limit once the gate
legitimately fires is an open question.

## Fail-open and logging

The plugin is strictly fail-open: no hook spawn error, timeout, non-zero exit, JSON parse
failure, oversized output, transcript write/rotation error, or skill/effect registration
failure may ever throw into the loop. `apply()` is fail-open too — a malformed config shape is
normalized to the documented defaults, and every repaired value is logged at warn.

Fail-open does **not** mean silent. Messages are gated by `logging.level`
(`off | error | warn | debug`, default `warn`; `debug` also enables `info`). A hook failure is
reported **once at warn/error and never repeated by the call site**: the transport line from
`lib/clawmem.js` carries the hook name, the session id (when the hook input has one), the
elapsed milliseconds and, on a non-zero exit, the exit code plus the close `signal` (`none`
when the child reported none) and — when `logging.logHookStderr` is true — the captured stderr
text. The call-site reason (`pre-step`, `created`, per-turn extraction, `pending kept`)
is emitted at **debug** instead. A failing hook therefore normally costs exactly one visible warn
line — the call site never repeats it, with the capped-stderr exception noted below — while the
reason stays available under `logging.level: debug` (a client that reports no line of its own
leaves the call-site line at warn, so a failure can never be invisible):

- spawn failure, child `error`, and stdin failure;
- timeout — the single error line names the limit, then the child is SIGKILLed;
- non-zero exit — exit code plus the close `signal`, with captured stderr per
  `logging.logHookStderr`;
- stdout above the 1,048,576-byte cap — one warn line, the captured buffer is truncated to the
  cap, and the run returns `ok: false, oversized: true`;
- stderr above the same cap — one warn line, the captured stderr is truncated to the cap;
- empty or invalid JSON stdout — one warn line and yields no context; the run itself is not
  treated as a failure and still resolves `ok: true` with `parseIssue: 'empty'` or `'invalid'`
  (informational: a consumer keying only on `ok` would read
  unparseable output as a success, while the plugin reads no context from it and never reports it
  as a hook failure).

The non-zero-exit preview is the child's own stderr, escaped to one line (CR and LF become the
two-character forms `\r` and `\n`, so child output cannot forge log lines) and capped at 500
characters. It may therefore contain child-rendered text, including user content the child echoed;
set `logging.logHookStderr: false` to keep that preview out of the log entirely (stderr is still
captured on the result).

Severity is deliberately asymmetric in the transport: a timeout, a non-zero exit, a spawn/child `error` and a stdin failure are logged
at **error**, while oversized stdout, a capped stderr, invalid JSON and empty stdout are logged
at **warn**.

One run can still cost **two** visible transport lines: a capped stderr **plus** a non-zero exit
produces the WARN `stderr exceeded N bytes (capped)` — emitted as soon as the cap is hit — and
then the ERROR `exited code=…` on close. "Once" therefore describes the call site never repeating
the failure; it does not promise that the transport emits a single line. (The stdout-cap notice
rides the successful-exit path, so it never pairs with the exit error.)

A downstream throw from `next()` inside the `agent/pre-step` waterfall is logged at warn and
re-thrown, never swallowed, so a later handler's failure still reaches the host.

Messages at `debug`/`info` therefore require `logging.level: debug`; that includes
pressure-gate skips (with the reason and the winning threshold), subagent-policy skips,
extraction throttle/coalesce/drop notes, the call-site hook-failure reasons, the
snapshot-fallback note, the jobs-registry-absent note, and the two defensive-catch fallbacks
(the subagent-lineage predicate and the transcript-path fallback). Transcript write and rotation
messages are emitted directly to `ctx.logger` and are not filtered by `logging.level`.

### Where those lines go

`logging.level` decides which lines the plugin produces, but nothing carries them out of the
process by default: this composition mounts no logger exporter, and Cordis's built-in one is a
1,000-record in-memory ring buffer whose level gate defaults to INFO, so every plugin `warn` would
be dropped and its `error` lines would fill an array nothing reads. On activation the plugin
registers its own exporter through `ctx.logger.exporter(...)` (the
`installLogExporter` helper in `lib/index.js`) that mirrors its own lines to `process.stderr`, which
the `dsh-web.service` unit sends to the systemd journal. The sink is filtered by logger name
(`message.name === 'dsh-clawmem'`), so other rows' lines are not duplicated, and it honours
`logging.level` (`createStderrExporter` in `lib/index.js`):

- `off` - no exporter is registered at all;
- `error` - error lines only;
- `warn` (default) - warn and error;
- `debug` - error, warn, info and debug.

Each mirrored message is written as one physical line, `[clawmem][<type>] <text>`, with CR and
LF in the rendered text escaped to the two-character forms `\r` and `\n`; the rendered text is
then truncated to 4,000 characters (the `STDERR_MAX_CHARS` constant and the truncation step in
`createStderrExporter`'s `export()`, both in `lib/index.js`), so a field such as an untrusted
session id can never forge a second journald line. Registration is an ordinary disposable (the `ctx.logger.exporter(...)` call
inside `installLogExporter` in `lib/index.js`), so the exporter is removed on unload, and an absent,
hostile or throwing `exporter()` API, or a broken `process.stderr`, can neither break activation nor
a run (fail-open).

### Extraction scheduling

`agent/turn-stopping` is registered **serial**. A turn is skipped when fewer than
`extraction.minNewMessages` new messages were recorded, then throttled per session for
`extraction.minIntervalMs` unless `extraction.forceBeforeCompaction` is true and the
pre-compaction gate has fired since the last extraction (the forced run consumes that flag).
Because the gate is evaluated on every `agent/pre-step`, a session **above** the gate re-arms the
flag on every step, so the throttle is effectively disabled for the whole above-gate period,
giving **one extraction per completed turn** rather than only the turn after the gate first fires.
The throttle applies only below the gate (or with `forceBeforeCompaction: false`). A run is
detached through `ctx.jobs` (`kind: 'clawmem-extraction'`) when the JobRegistry seam resolves,
otherwise through a guarded detached promise that can never produce an unhandled
rejection. The submission is deliberately unowned (an owned job would push a completion
notice into the conversation for every extraction run), and where no job controller serves it - in
this deployment the web-app bundle patches the host-plane tool-jobs row to `disabled: true` while the
agent presets mount only its model-facing controls - `ctx.jobs.start` fails: `detach` in `lib/index.js` logs **one** warn for that plugin
instance (`job registry unavailable for clawmem-extract <session>`) and every later failure at debug
(a failure after a successful submission warns again), then falls through to that guarded promise. A
seam that resolves to no registry at all skips the warn, logs one `job registry absent; using the
guarded detached promise for <label>` at debug the first time, and goes straight there. The turn is never
blocked either way; what such a composition cannot offer is job tracking and cancellation. At most
`extraction.maxConcurrentJobs` runs are in flight globally. When a turn cannot start a run,
`coalesce: true` records one pending run per session in a FIFO queue that `drainCoalesced()`
drains as soon as a run finishes and a slot is free - including when the **global cap**, not that
session's own in-flight run, was the blocker; a queued session that has already run by then is
skipped. `coalesce: false` **drops the turn rather than queueing it**.

## Subagent policy

`subagents.policy` controls inclusion; the default is `exclude`. The predicate reads
`session.header` first (`header.origin === 'subagent'` or a set `header.parentSession`), then
falls back to `session.meta` and finally to top-level `session.origin`/`session.parentSession`,
covering every observed host shape. Only those two conditions exclude a session — no other
origin is excluded by accident. Excluded sessions get no transcript lines, no pre-step
injection and no hook spawn. Set the policy to `extract` or `full` to include subagent
sessions. Policy skips are logged at debug with the event name and session id.

## Transcript and rotation

A ClawMem-readable transcript is written per session to
`<transcript.dir>/<sessionId>/transcript.jsonl` (absolute, `.jsonl`, one JSON object per line,
Claude-compatible `{type:"message", message:{role, content}}`) so
`memory/precompact-state.md` is isolated per session. The default `transcript.dir` is
`<DSH_HOME>/clawmem-transcripts` (`~/.dsh/clawmem-transcripts`).

Emitted: genuine user text (only events whose `data.source.kind` is `user`), assistant content
(text, `tool_use` with parsed arguments, `[image]` for image blocks, and a file handle with
name/size plus the `{"file_path":...}` form when the block exposes a path), a synthesized
**assistant** `tool_use` line for a `tool/call` that no assistant message carried
(de-duplicated by `callId`), and `tool_result` lines (content truncated to
`transcript.maxToolResultChars`, default 500) whose identical re-delivery for the same
`tool_use_id` is dropped. That per-session de-duplication memory is a bounded FIFO window
of the 2,048 most recent result fingerprints, so it cannot grow without bound and a very old
identical result re-delivered after enough later results may be re-emitted. That bound applies
to result fingerprints only: the synthesized-`tool_use` de-duplication uses a separate
per-session set of callIds that is never evicted, because capping it would allow an old callId
to re-emit a synthesized assistant `tool_use` and weaken the zero-duplicate-`tool_use_id`
property. It is far lighter than the fingerprint window (one short id per tool call, against
fingerprints that embed up to 500 characters of result text) but it is not bounded; it is
dropped only when the manager closes (see Known limitations). Multi-block tool results are emitted in
full, not just the first block. Excluded: system messages,
plugin-injected user messages, reasoning blocks, and empty content lines.

File-handle text comes from a single helper, `fileHandleText` in `lib/transcript.js`, shared by
the assistant file block and the user file handle: `[file name="…" bytes=N
{"file_path":"…"}]`, where the `{"file_path":…}` part appears only when the block — or the
attachment reference it wraps — exposes a credible path (starts with `/` or `~`, longer than 10
characters). The non-empty name and the byte size always survive; a block with no name, size or
path falls back to `attachment="…"`, or to `[file]` when there is no id either.

Rotation is enabled by default and sweeps per-session directories whose newest entry is older
than `transcript.rotation.maxAgeDays` (default 180) every
`transcript.rotation.sweepIntervalHours` (default 24); the timer is `unref`'d. One guarded sweep
also runs **at activation**, before that interval is armed, so a process restarted more often than
`transcript.rotation.sweepIntervalHours` still prunes. Disabling rotation
(`transcript.rotation.enabled: false`) stops all pruning. Write and rotation failures are logged,
never thrown.

### Session identity handed to ClawMem

ClawMem names its per-session artifacts from `sessionId.slice(0, 8)`
(`handoffs/<date>-<id8>.md`, the decision and observation paths) and builds its same-session
exclusion (and its invalidated-by lookup) from the same key. Every DSH main session id starts with
`session-`, so all of one day's main sessions collapsed onto the single doc `<date>-session-.md`
and the decision extractor's same-session exclusion filtered out every prior DSH decision. Session
focus and multi-turn surfacing key on the **full** id, so those were already per session.

`clawmemSessionId` (the helper in `lib/index.js`) now strips **one** leading `session-` from the id
the plugin hands to ClawMem, and every hook payload goes through it - the `runPrecompact` and
`runExtract` helpers, the `agent/created` bootstrap loop, the `context-surfacing` call in
`agent/pre-step` and the `postcompact-inject` call site there (all in `lib/index.js`) - so artifact
names and `context_usage` rows are per session (session focus and multi-turn history already were,
because ClawMem keys them on the full id). An id without that prefix (a bare-uuid subagent id) is
passed through unchanged. Documents already collapsed under the old shared key are left as they are - they remain the honest
record of the old naming.

The **transcript path is not renamed**: the transcript directory, `transcript_path` and the
per-session state keep the real DSH session id (the `session/event` listener, the `runPrecompact`
helper and the post-compaction block of `agent/pre-step` in `lib/index.js` all pass the unmodified
`session.id` to `writerFor`/`pathFor`). The pre/post-compaction round trip depends on that path
rather than on the id - `postcompact-inject` now receives the same `transcript_path` as
`precompact-extract` (the `postcompact-inject` call site in `agent/pre-step`, `lib/index.js`), so
ClawMem reads the authoritative `memory/precompact-state.md` from `dirname(transcript_path)`; the two calls therefore agree on the path ClawMem reads.

### Pre-compaction state: `## Last User Request`

The `## Last User Request` section of `memory/precompact-state.md` normally holds a
`tool_result` blob rather than the human's prompt. This writer emits tool results as
`role: "user"` (`appendToolResult` in `lib/transcript.js`, matching the Claude Code /
Anthropic transcript contract), and ClawMem's `getLastUserRequest`
(`clawmem/src/hooks/precompact-extract.ts`) scans backwards for the last user-role message
longer than 10 characters - which, after a tool-using turn, is that result rather than the
prompt. It is ClawMem-side behaviour that matches its Claude Code integration, so it is
**recorded as accepted** and not a plugin defect: the plugin keeps the contract-conformant
role rather than remapping tool results to make one section of one file read better.

## Routing block and skill

At activation the plugin reads `routing-block.dsh.md` and registers it through
`ctx.systemPrompt.section` as `{name: 'clawmem:routing', order: 300}`; `systemPrompt` is
declared in the plugin's `inject` list, so the seam is reachable. `routing-block.dsh.md` is
the DSH adaptation of the upstream ClawMem routing baseline
`clawmem_option_b_trigger_block.md`; that upstream file is kept outside the repository
(gitignored as `clawmem_option_b_trigger_block.md`, so it is never in the repository or a
clone) and deliberately excluded from the npm package, while the adapted
`routing-block.dsh.md` is tracked in git and shipped in the package. `routingBlock.mode: off`
disables it, and a missing block file is logged at warn.

`skill.register: true` registers ClawMem's `SKILL.md` as the `clawmem` skill: read once at
activation from the resolved ClawMem **package** directory - `resolve(dirname(realpathSync(bin)), '..')`
on the binary the hook client resolved (not the raw `clawmemBin` value), in `lib/index.js`; the
realpath'd binary lives in `<package>/bin`, and its parent is the package root that holds `SKILL.md`
(e.g. `/usr/lib/node_modules/clawmem`) -
frontmatter stripped, `resourceBase` pointing at that directory, and a string
`source` so DSH's load-time validation accepts it. A session sees only the small catalog
entry; the body enters context when the skill tool loads it. `routingBlock`/`skill` are
intentionally complementary. A missing or unreadable `SKILL.md` is logged at warn.

## Lifecycle

Listeners, the logger exporter, the routing section, the rotation sweep (one at activation plus
the interval) and the transcript
manager are registered through `ctx.effect` when the host provides it (and collected either way),
so a fiber unload disposes them and `transcripts.close()` runs on disposal. `apply()` returns a
teardown function that disposes everything it registered; a failing disposer is logged at warn
rather than thrown.

## Known limitations

These are known, accepted limits of the plugin as shipped. Each one is either ClawMem-side behaviour the
plugin deliberately conforms to, or a trade-off that was reviewed and accepted rather than papered over.

- **File-path extraction yields nothing under the `ptc` preset.** Every live `tool_use` line is
  `run_code`, and the preset's inner read/write/edit calls arrive as `tool/ptc-dispatch*` session events
  that the transcript writer never sees, so ClawMem's `extractFilePaths` finds no path and the
  pre-compaction state file has no "Files Modified This Session" section; `extractFilesChanged` stays dead
  for the same reason. Translating those events into assistant `tool_use` lines would fix it, at the cost
  of a transcript source outside the documented source-to-line table.
- **User file attachments never contribute extracted file paths.** A user file attachment's handle text
  lands on a `role:"user"` transcript line and carries the same `{"file_path":…}` form as the assistant
  path, but ClawMem's `extractFilePaths` scans assistant content only - its loop skips every message whose
  role is not `assistant` - so user attachments never contribute extracted paths. Assistant file blocks
  and assistant `tool_use` lines do extract, and DSH emits an assistant `tool_use` line for every file the
  agent reads. Closing the user path needs a ClawMem-side change or fabricated assistant content.
- **Per-session state map has no eviction.** The plugin keeps one entry per session in a process-lifetime
  `Map` (bootstrap text, pending flags, throttle counters) with no eviction: bounded in practice by how
  many sessions the process sees, but not capped in code.
- **Synthesized-`tool_use` callId de-duplication is unbounded.** The `tool_result` fingerprint store is a
  bounded FIFO window of the 2,048 most recent fingerprints per session, but the set that stops a
  synthesized `tool/call` line from re-emitting a callId an assistant message already carried
  (`seenBySession`) is per-session and never evicted. Capping it would allow an old callId to re-emit a
  synthesized assistant `tool_use`, weakening the zero-duplicate-`tool_use_id` property. It is
  memory-light - one short id per tool call rather than an up-to-500-character result fingerprint - but
  unbounded over the process lifetime; only `transcripts.close()` on disposal clears it.
- **`staleness-check` cannot emit `additionalContext`.** ClawMem maps that hook to a null event, so the
  plugin can run it (when `bootstrap.stalenessCheck` is true) but it contributes no context.

## License

MIT
