/** dsh-clawmem: ClawMem parity for DSH. */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { createTranscriptManager, fileHandleText } from './transcript.js'
import { createClawmemClient, extractContext, isRegularFile, resolveClawmemBin } from './clawmem.js'
import { shouldPrecompact, resolveCompactionThresholdRatio } from './pressure.js'
import { resolveDshModule } from './dsh-resolve.js'

export const name = 'dsh-clawmem'
export const inject = ['skills', 'sessionProjections', 'systemPrompt']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const LF = String.fromCharCode(10)
const DOUBLE = LF + LF
// DSH requires a non-empty string source on a runtime skill definition
// (validateDefinition, packages/skill/skill/src/index.ts:765); without it the
// registered skill is listed in the catalog but throws on load.
const SKILL_SOURCE = 'clawmem'

const DEFAULTS = {
  // R-2: no machine path ships. null = auto; lib/clawmem.js resolves the chain
  // config -> $CLAWMEM_BIN -> `clawmem` on PATH -> $HOME/.npm-global/bin/clawmem.
  clawmemBin: null,
  profile: 'balanced',
  logging: { level: 'warn', logHookStderr: true },
  surfacing: { enabled: true, timeoutMs: 2000, minPromptChars: 20 },
  bootstrap: { sessionBootstrap: true, curatorNudge: true, stalenessCheck: true },
  precompact: { enabled: true, proximityRatio: 0.8, compactionThresholdRatio: 0.8, fallbackTriggerTokens: 100000, fallbackOnCompactionStart: true, timeoutMs: 5000 },
  postcompact: { enabled: true },
  extraction: { enabled: true, timeoutMs: 30000, minIntervalMs: 10000, coalesce: true, maxConcurrentJobs: 1, minNewMessages: 2, forceBeforeCompaction: true, hooks: ['decision-extractor', 'handoff-generator', 'feedback-loop'] },
  subagents: { policy: 'exclude' },
  transcript: { dir: null, rotation: { enabled: true, maxAgeDays: 180, sweepIntervalHours: 24 }, maxToolResultChars: 500 },
  skill: { register: true, name: 'clawmem' },
  routingBlock: { mode: 'section' },
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A usable finite number field of a pressure view, else undefined. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const PROFILES = ['speed', 'balanced', 'deep']
const SUBAGENT_POLICIES = ['exclude', 'extract', 'full']
const ROUTING_MODES = ['section', 'off']
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Read one config section defensively: a non-record section reads as empty,
 *  but the repair is always reported (a YAML "transcript:" parses to null, so a
 *  silent empty section is a real shape - F-1). */
function section(raw, key, issues) {
  if (!isRecord(raw)) return {}
  const value = raw[key]
  if (value === undefined) return {}
  if (isRecord(value)) return value
  note(issues, key + ' is not an object; using the documented defaults')
  return {}
}

function topLevel(raw, key) {
  return isRecord(raw) ? raw[key] : undefined
}

function note(issues, message) {
  if (issues) issues.push(message)
}

function boolOf(value, fallback, label, issues) {
  if (typeof value === 'boolean') return value
  if (value !== undefined) note(issues, label + ' is not a boolean; using ' + String(fallback))
  return fallback
}

// R4 #16 / X3 D2: null is the DOCUMENTED default for both auto-resolved paths
// (clawmemBin and transcript.dir), so an explicit null must NOT be reported as a repaired
// value - only a genuinely malformed value is noted.
function autoStringOf(value, fallback, label, issues) {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value === undefined || value === null) return fallback
  note(issues, label + ' is not a non-empty string; using ' + String(fallback))
  return fallback
}

function stringOf(value, fallback, label, issues) {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value !== undefined) note(issues, label + ' is not a non-empty string; using ' + String(fallback))
  return fallback
}

function numberOf(value, fallback, minimum, label, issues) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= minimum) return value
  if (value !== undefined) note(issues, label + ' is not a number >= ' + String(minimum) + '; using ' + String(fallback))
  return fallback
}

function integerOf(value, fallback, minimum, label, issues) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= minimum) return value
  if (value !== undefined) note(issues, label + ' is not an integer >= ' + String(minimum) + '; using ' + String(fallback))
  return fallback
}

function enumOf(value, allowed, fallback, label, issues) {
  if (typeof value === 'string' && allowed.includes(value)) return value
  if (value !== undefined) note(issues, label + ' is not one of ' + allowed.join('/') + '; using ' + fallback)
  return fallback
}

/** F-2: skill.name must satisfy SKILL_NAME_RE; every other enum warns, so does this. */
function skillNameOf(value, issues) {
  if (typeof value === 'string' && SKILL_NAME_RE.test(value)) return value
  if (value !== undefined) note(issues, 'skill.name does not match ' + String(SKILL_NAME_RE) + '; using ' + DEFAULTS.skill.name)
  return DEFAULTS.skill.name
}

function hooksOf(value, issues) {
  if (Array.isArray(value)) {
    const hooks = value.filter(function (hook) { return typeof hook === 'string' && hook.trim() !== '' })
    if (hooks.length > 0) return hooks
    note(issues, 'extraction.hooks has no usable hook name; using the documented default')
    return DEFAULTS.extraction.hooks.slice()
  }
  if (value !== undefined) note(issues, 'extraction.hooks is not an array; using the documented default')
  return DEFAULTS.extraction.hooks.slice()
}

/** Build the fully normalized config; `issues` collects every repaired value. */
function buildConfig(raw, issues) {
  const logging = section(raw, 'logging', issues)
  const surfacing = section(raw, 'surfacing', issues)
  const bootstrap = section(raw, 'bootstrap', issues)
  const precompact = section(raw, 'precompact', issues)
  const postcompact = section(raw, 'postcompact', issues)
  const extraction = section(raw, 'extraction', issues)
  const subagents = section(raw, 'subagents', issues)
  const transcript = section(raw, 'transcript', issues)
  const rotation = isRecord(transcript.rotation) ? transcript.rotation : {}
  if (transcript.rotation !== undefined && !isRecord(transcript.rotation)) note(issues, 'transcript.rotation is not an object; using the documented default')
  const skill = section(raw, 'skill', issues)
  const routingBlock = section(raw, 'routingBlock', issues)
  // F-1: null is a real malformed top level too ("config:" with no value).
  if (raw !== undefined && !isRecord(raw)) note(issues, 'plugin config is not an object; using the documented defaults')
  const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
  return {
    clawmemBin: autoStringOf(topLevel(raw, 'clawmemBin'), DEFAULTS.clawmemBin, 'clawmemBin', issues),
    profile: enumOf(topLevel(raw, 'profile'), PROFILES, DEFAULTS.profile, 'profile', issues),
    logging: {
      level: enumOf(logging.level, Array.from(LOG_LEVELS), DEFAULTS.logging.level, 'logging.level', issues),
      logHookStderr: boolOf(logging.logHookStderr, DEFAULTS.logging.logHookStderr, 'logging.logHookStderr', issues),
    },
    surfacing: {
      enabled: boolOf(surfacing.enabled, true, 'surfacing.enabled', issues),
      timeoutMs: numberOf(surfacing.timeoutMs, DEFAULTS.surfacing.timeoutMs, 1, 'surfacing.timeoutMs', issues),
      minPromptChars: numberOf(surfacing.minPromptChars, DEFAULTS.surfacing.minPromptChars, 0, 'surfacing.minPromptChars', issues),
    },
    bootstrap: {
      sessionBootstrap: boolOf(bootstrap.sessionBootstrap, true, 'bootstrap.sessionBootstrap', issues),
      curatorNudge: boolOf(bootstrap.curatorNudge, true, 'bootstrap.curatorNudge', issues),
      stalenessCheck: boolOf(bootstrap.stalenessCheck, true, 'bootstrap.stalenessCheck', issues),
    },
    precompact: {
      enabled: boolOf(precompact.enabled, true, 'precompact.enabled', issues),
      proximityRatio: numberOf(precompact.proximityRatio, DEFAULTS.precompact.proximityRatio, Number.MIN_VALUE, 'precompact.proximityRatio', issues),
      compactionThresholdRatio: numberOf(precompact.compactionThresholdRatio, DEFAULTS.precompact.compactionThresholdRatio, Number.MIN_VALUE, 'precompact.compactionThresholdRatio', issues),
      fallbackTriggerTokens: numberOf(precompact.fallbackTriggerTokens, DEFAULTS.precompact.fallbackTriggerTokens, 0, 'precompact.fallbackTriggerTokens', issues),
      fallbackOnCompactionStart: boolOf(precompact.fallbackOnCompactionStart, true, 'precompact.fallbackOnCompactionStart', issues),
      timeoutMs: numberOf(precompact.timeoutMs, DEFAULTS.precompact.timeoutMs, 1, 'precompact.timeoutMs', issues),
    },
    postcompact: { enabled: boolOf(postcompact.enabled, true, 'postcompact.enabled', issues) },
    extraction: {
      enabled: boolOf(extraction.enabled, true, 'extraction.enabled', issues),
      timeoutMs: numberOf(extraction.timeoutMs, DEFAULTS.extraction.timeoutMs, 1, 'extraction.timeoutMs', issues),
      minIntervalMs: numberOf(extraction.minIntervalMs, DEFAULTS.extraction.minIntervalMs, 0, 'extraction.minIntervalMs', issues),
      coalesce: boolOf(extraction.coalesce, DEFAULTS.extraction.coalesce, 'extraction.coalesce', issues),
      maxConcurrentJobs: integerOf(extraction.maxConcurrentJobs, DEFAULTS.extraction.maxConcurrentJobs, 1, 'extraction.maxConcurrentJobs', issues),
      minNewMessages: integerOf(extraction.minNewMessages, DEFAULTS.extraction.minNewMessages, 0, 'extraction.minNewMessages', issues),
      forceBeforeCompaction: boolOf(extraction.forceBeforeCompaction, DEFAULTS.extraction.forceBeforeCompaction, 'extraction.forceBeforeCompaction', issues),
      hooks: hooksOf(extraction.hooks, issues),
    },
    subagents: { policy: enumOf(subagents.policy, SUBAGENT_POLICIES, DEFAULTS.subagents.policy, 'subagents.policy', issues) },
    transcript: {
      dir: autoStringOf(transcript.dir, join(home, 'clawmem-transcripts'), 'transcript.dir', issues),
      rotation: {
        enabled: boolOf(rotation.enabled, DEFAULTS.transcript.rotation.enabled, 'transcript.rotation.enabled', issues),
        maxAgeDays: numberOf(rotation.maxAgeDays, DEFAULTS.transcript.rotation.maxAgeDays, 1, 'transcript.rotation.maxAgeDays', issues),
        sweepIntervalHours: numberOf(rotation.sweepIntervalHours, DEFAULTS.transcript.rotation.sweepIntervalHours, 1, 'transcript.rotation.sweepIntervalHours', issues),
      },
      maxToolResultChars: numberOf(transcript.maxToolResultChars, DEFAULTS.transcript.maxToolResultChars, 0, 'transcript.maxToolResultChars', issues),
    },
    skill: {
      register: boolOf(skill.register, true, 'skill.register', issues),
      name: skillNameOf(skill.name, issues),
    },
    routingBlock: { mode: enumOf(routingBlock.mode, ROUTING_MODES, DEFAULTS.routingBlock.mode, 'routingBlock.mode', issues) },
  }
}

/**
 * Resolve the plugin config against the documented 6.4 defaults. Fail-open and
 * pure: a malformed value can only ever be replaced by its documented default,
 * never thrown (M6/D-18).
 */
export function resolveConfig(raw) {
  return buildConfig(raw, null)
}

/** The list of config values that were repaired (used to log the anomaly). */
export function configIssues(raw) {
  const issues = []
  buildConfig(raw, issues)
  return issues
}

/**
 * Map the resolved config onto the frozen createClawmemClient options so the
 * documented logging/profile keys actually reach the hook transport (M1).
 */
export function clientOptionsFor(config, logger, resolvedBinChoice) {
  const resolved = isRecord(config) ? config : resolveConfig(config)
  const logging = isRecord(resolved.logging) ? resolved.logging : {}
  const explicitBin = autoStringOf(resolved.clawmemBin, null, 'clawmemBin', null)
  const choice = isRecord(resolvedBinChoice) ? resolvedBinChoice : null
  // apply() resolves the chain once (R3 #11 / R4 #13) and passes { bin, source }; when
  // it does not, null is forwarded and the client resolves the chain itself.
  const forwarded = explicitBin !== null ? explicitBin : (choice && typeof choice.bin === 'string' && choice.bin !== '' ? choice.bin : null)
  return {
    bin: forwarded,
    binSource: explicitBin !== null ? 'config' : (choice && typeof choice.source === 'string' ? choice.source : undefined),
    logger: logger,
    level: enumOf(logging.level, Array.from(LOG_LEVELS), DEFAULTS.logging.level, 'logging.level', null),
    logStderr: boolOf(logging.logHookStderr, DEFAULTS.logging.logHookStderr, 'logging.logHookStderr', null),
    profile: enumOf(resolved.profile, PROFILES, DEFAULTS.profile, 'profile', null),
  }
}

// R3 #11: the client that stands in when the hook transport cannot be created must still
// carry the resolved binary, or the skill path would be skipped silently.
/** Internal seam: the stand-in hook client used when the transport cannot be created. */
export function unavailableClient(binChoice) {
  const choice = isRecord(binChoice) ? binChoice : {}
  return {
    runHook: async function () { return { ok: false, stdout: '', stderr: '', code: null, context: '', oversized: false } },
    bin: typeof choice.bin === 'string' && choice.bin !== '' ? choice.bin : null,
    binSource: 'fallback',
  }
}

/**
 * Internal seam: build the hook client from the resolved choice, falling back to a stand-in
 * that still carries the binary when construction fails. The factory is injectable so the
 * fallback path is testable without a real transport failure.
 */
export function createHookClient(config, logger, binChoice, factory) {
  const create = typeof factory === 'function' ? factory : createClawmemClient
  try {
    return { client: create(clientOptionsFor(config, logger, binChoice)), error: null }
  } catch (error) {
    return { client: unavailableClient(binChoice), error: error }
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error)
}

// Severity ranks: a message is emitted when its rank is at or below the
// configured level. 'info' therefore needs level 'debug', which matches the
// observed deployment (nothing at info reaches journald).
/** Producer kind for a detached extraction job (ctx.jobs, D-5). */
export const EXTRACTION_JOB_KIND = 'clawmem-extraction'

/**
 * Run `fn` detached from the caller and guarantee the returned promise never
 * rejects: a synchronous throw, a returned rejection and a hostile onError are
 * all contained, so a failing extraction can never become an unhandled
 * rejection that kills the host (H4/D-18).
 */
export function guardDetached(fn, onError) {
  let result
  try { result = Promise.resolve().then(function () { return fn() }) }
  catch (error) { result = Promise.reject(error) }
  return result.catch(function (error) {
    try { if (typeof onError === 'function') onError(error) } catch { /* fail-open: reporting never throws */ }
  })
}

const LOG_RANKS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }
const LOG_LEVELS = new Set(['off', 'error', 'warn', 'debug'])

// cordis numbers severity the other way round (ERROR=0, INFO=1, WARN=2, DEBUG=3)
// and its exporter gate keeps a message when the exporter's own threshold is
// >= the message level. Asking for DEBUG therefore pre-drops nothing, and the
// plugin's LOG_RANKS decides - so the exporter and createLevelLogger agree.
const CORDIS_EXPORT_ALL = 3
const STDERR_PREFIX = '[clawmem]'
const STDERR_MAX_CHARS = 4000
const STDERR_TRUNCATED = '...[truncated]'

/** Render one message argument without ever throwing. */
function renderLogArg(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object' && typeof value !== 'function') {
    try { return String(value) } catch { return '[unprintable]' }
  }
  try {
    const text = String(value)
    if (text !== '[object Object]') return text
  } catch { /* fall through to inspect */ }
  try { return inspect(value, { depth: 2, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 500 }) } catch { return '[unprintable]' }
}

/**
 * N-1: this deployment mounts no logger exporter - cordis's built-in one is a
 * 1000-record ring buffer whose level gate defaults to INFO (logger.ts:155-156),
 * so a plugin warn never reaches anything. Build the exporter that writes one
 * gated line per plugin message to process.stderr. Returns undefined for
 * logging.level 'off' (then nothing is registered at all).
 */
export function createStderrExporter(level, pluginName) {
  const ceiling = LOG_RANKS[LOG_LEVELS.has(level) ? level : 'warn']
  if (ceiling <= LOG_RANKS.off) return undefined
  const onlyName = typeof pluginName === 'string' && pluginName !== '' ? pluginName : 'dsh-clawmem'
  return {
    // Do not let cordis's own gate pre-drop warn/debug (its default is INFO=1).
    levels: { default: CORDIS_EXPORT_ALL },
    export: function (message) {
      try {
        if (!message || typeof message !== 'object') return
        if (message.name !== onlyName) return
        const rank = LOG_RANKS[message.type]
        if (typeof rank !== 'number' || rank > ceiling) return
        let text = (Array.isArray(message.args) ? message.args : []).map(renderLogArg).join(' ')
        if (text.length > STDERR_MAX_CHARS) text = text.slice(0, STDERR_MAX_CHARS) + STDERR_TRUNCATED
        // One line per message; never through the logger, so this cannot recurse.
        process.stderr.write(STDERR_PREFIX + '[' + String(message.type) + '] ' + text + LF)
      } catch { /* fail-open: a broken stderr must never break the host (D-18) */ }
    },
  }
}

/** Wrap the host logger so config.logging.level gates every plugin message
 *  and a hostile or broken logger can never throw into the loop (D-18). */
export function createLevelLogger(logger, level) {
  const ceiling = LOG_RANKS[LOG_LEVELS.has(level) ? level : 'warn']
  function emit(name, message) {
    if (LOG_RANKS[name] > ceiling) return
    try {
      const fn = logger && typeof logger[name] === 'function' ? logger[name] : undefined
      if (typeof fn === 'function') fn.call(logger, message)
    } catch { /* fail-open: logging never breaks the host */ }
  }
  return {
    error: function (message) { emit('error', message) },
    warn: function (message) { emit('warn', message) },
    info: function (message) { emit('info', message) },
    debug: function (message) { emit('debug', message) },
  }
}

/**
 * Text of message/tool-result content. `mode` is 'result' only for the
 * transcript's tool-result path: nested image/file blocks there must not lose
 * their text (F-3). The direct message path (agent/pre-step prompt text) passes
 * no mode, so it keeps the exact text/tool-result behaviour it had before F-3 -
 * the mode propagates through nesting instead of being forced on.
 */
function textOf(content, mode) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(function (block) {
      if (!block) return ''
      if (block.type === 'text') return block.text || ''
      if (block.type === 'tool-result') return textOf(block.content, mode)
      // F-3: an inner image/file block must not lose its text.
      if (mode === 'result' && block.type === 'image') return '[image]'
      if (mode === 'result' && block.type === 'file') return fileHandleText(block)
      return ''
    }).filter(Boolean).join(LF)
  }
  return ''
}

/**
 * Map DSH user content blocks to transcript text (6.3): text -> text,
 * image -> '[image]', file -> its handle text, tool-result -> its text.
 */
export function userTextOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(function (block) {
    if (typeof block === 'string') return block
    if (!isRecord(block)) return ''
    if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
    if (block.type === 'image') return '[image]'
    // N-7: one shared path-bearing handle format with the assistant path.
    if (block.type === 'file') return fileHandleText(block)
    if (block.type === 'tool-result') return textOf(block.content, 'result')
    return ''
  }).filter(Boolean).join(LF)
}

/** Text of one tool/result content block. */
function blockTextOf(block) {
  if (typeof block === 'string') return block
  if (!isRecord(block)) return ''
  if (Array.isArray(block.content) || typeof block.content === 'string') return textOf(block.content, 'result')
  if (typeof block.text === 'string') return block.text
  return textOf(block)
}

/** The user content of a user/message event, whichever host shape carries it. */
function userContentOf(event) {
  const data = event && event.data
  if (!isRecord(data)) return undefined
  if (data.content !== undefined) return data.content
  return isRecord(data.message) ? data.message.content : undefined
}

export function parseSkillFrontmatter(text) {
  const src = String(text == null ? '' : text)
  const lines = src.split(LF)
  if (lines.length === 0 || lines[0].trim() !== '---') return { description: '', body: src.trim() }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) { if (lines[i].trim() === '---') { end = i; break } }
  if (end === -1) return { description: '', body: src.trim() }
  let description = ''
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    if (line.startsWith('description:')) {
      let value = line.slice('description:'.length).trim()
      const DQ = String.fromCharCode(34)
      if (value.startsWith(DQ) && value.endsWith(DQ)) value = value.slice(1, -1)
      description = value
      break
    }
  }
  let body = lines.slice(end + 1).join(LF)
  while (body.startsWith(LF)) body = body.slice(1)
  return { description: description, body: body.trim() }
}

/**
 * O2: ClawMem names its artifacts from sessionId.slice(0, 8)
 * (handoff-generator.ts:61, decision-extractor.ts:401,449,681) and every DSH
 * main session id starts with "session-", so all same-day main sessions
 * collapse into one doc (handoffs/<date>-session-.md) and the decision
 * extractor's same-session exclusion (decision-extractor.ts:221, with the LIKE
 * at :287) filters out every prior DSH decision doc. Session focus and
 * multi-turn surfacing key on the FULL id (session-focus.ts:48-49,
 * context-surfacing.ts:931-941), so those two were already per session; the
 * collision is in artifact naming and the extractor's key. Strip exactly
 * ONE leading "session-" at the ClawMem boundary; the transcript directory and
 * transcript_path keep the real DSH id (D-8). ClawMem has no id-shape contract:
 * nothing tests the prefix, nothing parses the id, the pre/post-compaction
 * state location is derived from transcript_path, and subagent gating uses
 * origin/parentSession. Deterministic, so one session sends one id everywhere.
 */
export function clawmemSessionId(id) {
  if (typeof id !== 'string') return ''
  return id.indexOf('session-') === 0 ? id.slice('session-'.length) : id
}

export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const logger = ctx && ctx.logger ? ctx.logger : undefined
  const log = createLevelLogger(logger, config.logging.level)
  const warn = log.warn
  const debug = log.debug
  const info = log.info
  const states = new Map()
  const collected = []
  let createUserMessageFn
  let inFlightRuns = 0
  // R8: the owner-less ctx.jobs submission (see detach) is unavailable in this
  // composition, so this instance warns on the FIRST registry failure and drops
  // later ones to debug - one line per apply(), not one per extraction run. A
  // successful submission resets it so a second outage is visible again.
  let jobRegistryWarned = false
  // L4: a composition with no jobs registry at all is legitimate (the guarded
  // detached promise is the documented fallback), so it is announced once per
  // apply() at debug - neither silently nor as a warning. A registry that
  // exists but throws keeps the round-8 warn-once diagnostic below.
  let jobRegistryAbsentLogged = false
  // N-1: register the stderr exporter before the first message is emitted, so a
  // repaired config (and every later warn/error) is actually visible.
  installLogExporter()
  for (const issue of configIssues(raw)) warn('dsh-clawmem: config repaired: ' + issue)
  let client
  // R3 #11 / R4 #13: resolve the chain ONCE, so the hook client, the fallback client
  // and the skill package root all agree on the same binary and provenance.
  let binChoice = { bin: null, source: 'unresolved' }
  try { binChoice = resolveClawmemBin({ configured: config.clawmemBin }) } catch (error) { warn('dsh-clawmem: binary resolution failed: ' + errorMessage(error)) }
  const createdClient = createHookClient(config, logger, binChoice)
  if (createdClient.error) warn('dsh-clawmem: hook client unavailable: ' + errorMessage(createdClient.error))
  client = createdClient.client
  let transcripts
  try { transcripts = createTranscriptManager({ dir: config.transcript.dir, maxToolResultChars: config.transcript.maxToolResultChars, rotation: config.transcript.rotation, logger: logger }) }
  catch (error) { warn('dsh-clawmem: transcript manager unavailable: ' + errorMessage(error)); transcripts = { pathFor: function () { return '' }, writerFor: function () { return null }, sweep: function () { return { removed: 0, kept: 0, errors: 0 } }, close: function () {} } }
  /**
   * M3: register one disposable inside ctx.effect when the host provides it (so
   * a fiber unload tears everything down) and collect the disposer either way,
   * so apply() can return a working teardown for hosts without ctx.effect.
   */
  function registerDisposable(label, fn) {
    if (typeof ctx.effect === 'function') {
      try {
        const disposable = ctx.effect(function () {
          const disposer = fn()
          return typeof disposer === 'function' ? disposer : undefined
        }, label)
        if (typeof disposable === 'function') collected.push(disposable)
        return
      } catch (error) { warn('dsh-clawmem: effect registration failed (' + label + '): ' + errorMessage(error)) }
    }
    try {
      const disposer = fn()
      if (typeof disposer === 'function') collected.push(disposer)
    } catch (error) { warn('dsh-clawmem: registration failed (' + label + '): ' + errorMessage(error)) }
  }
  /**
   * N-1 (owner chose: honour logging.level): register the stderr exporter on the
   * host logger when that API exists - ctx.logger.exporter(exporter) returns a
   * disposer (vendor/cordis/src/logger.ts:232-236). An absent or hostile API is
   * fail-open: nothing is registered and apply() carries on.
   */
  function installLogExporter() {
    try {
      if (!logger || typeof logger.exporter !== 'function') return
      const exporter = createStderrExporter(config.logging.level, name)
      if (!exporter) return
      registerDisposable('clawmem:logger.exporter()', function () { return logger.exporter(exporter) })
    } catch (error) { warn('dsh-clawmem: log exporter registration failed: ' + errorMessage(error)) }
  }
  function listen(event, handler, options) {
    registerDisposable('clawmem:on(' + event + ')', function () { return ctx.on(event, handler, options) })
  }
  /**
   * M2 (D-5): run detached work through ctx.jobs when the JobRegistry seam
   * resolves, otherwise through a guarded microtask. Never throws and never
   * leaves an unhandled rejection. Returns a promise that always resolves.
   *
   * R8: the job spec is deliberately submitted WITHOUT an owner. tool-jobs
   * pushes a completion notice into the conversation for every owned job (it
   * skips only owner === undefined: packages/jobs/tool-jobs/src/index.ts:279),
   * so adding an owner here would inject model-visible noise on every
   * extraction run. Do NOT "fix" the warn below by adding an owner: keep the
   * owner-less call and suppress the repeat warning via jobRegistryWarned.
   */
  function detach(fn, label) {
    const fallback = function (error) { warn('dsh-clawmem: ' + label + ' failed: ' + errorMessage(error)) }
    try {
      const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
      if (jobs && typeof jobs.start === 'function') {
        let cancelled = false
        let tracked
        jobs.start({
          kind: EXTRACTION_JOB_KIND,
          label: label,
          run: function () {
            tracked = Promise.resolve().then(function () { return cancelled ? undefined : fn() }).then(
              function () { return { status: cancelled ? 'killed' : 'completed' } },
              function (error) { fallback(error); return { status: 'failed', detail: errorMessage(error) } },
            )
            return {
              cancel: function () { cancelled = true },
              done: tracked,
            }
          },
        })
        jobRegistryWarned = false
        return tracked || Promise.resolve()
      }
      // L4: no jobs service (or one without start()) - still a supported
      // composition, but no longer a silent one.
      if (!jobRegistryAbsentLogged) {
        jobRegistryAbsentLogged = true
        debug('dsh-clawmem: job registry absent; using the guarded detached promise for ' + label)
      }
    } catch (error) {
      // R8: the first failure keeps the exact message shape the deployment
      // diagnosis relies on; later failures are debug-only so a registry that
      // never resolves cannot emit one journald warn per extraction run.
      const message = 'dsh-clawmem: job registry unavailable for ' + label + ': ' + errorMessage(error)
      if (jobRegistryWarned) debug(message)
      else { jobRegistryWarned = true; warn(message) }
    }
    return guardDetached(fn, fallback)
  }
  /**
   * M1/D-19: one extraction run per session at a time, capped globally at
   * maxConcurrentJobs; with coalesce a turn that arrives during a run schedules
   * exactly one follow-up run.
   * L1: sessions whose turn arrived while the global cap was full. The
   * coalesced flag lives on the BLOCKED session's own state, so only a queue
   * can give it back the follow-up its debug line promises; the queue is
   * drained as soon as a run finishes and a slot is free (FIFO, at most one
   * pending run per session, per-session inFlight still respected).
   */
  const coalescedQueue = []
  function drainCoalesced() {
    // R14: a pass splices the whole queue out, so a throw between the splice and
    // the end of the pass used to lose every entry it had not processed yet.
    // Track the pass and put the unprocessed remainder back before returning.
    let pending = []
    let next = 0
    try {
      while (inFlightRuns < config.extraction.maxConcurrentJobs && coalescedQueue.length > 0) {
        // R13: never shift an entry off the queue and then discard it. An entry
        // whose own session is still in flight (or whose slot the cap has not
        // freed yet) cannot start now, so it must stay queued for the next
        // drain - shifting it out dropped a session's OWN coalesced follow-up
        // forever as soon as any foreign run finished first. Rebuild the queue
        // in order and only remove an entry whose run was actually scheduled.
        pending = coalescedQueue.splice(0, coalescedQueue.length)
        next = 0
        let scheduled = 0
        for (; next < pending.length; next += 1) {
          const nextId = pending[next]
          const nextState = states.get(nextId)
          // Drop a stale entry: the session already ran since it was queued
          // (this also removes any duplicate of a just-scheduled id).
          if (!nextState || !nextState.coalesced) continue
          if (nextState.inFlight || inFlightRuns >= config.extraction.maxConcurrentJobs) {
            coalescedQueue.push(nextId)
            continue
          }
          nextState.coalesced = false
          try {
            scheduleExtraction(nextId, nextState)
          } catch (error) {
            // R15/F1: scheduleExtraction resolves the transcript path before it
            // claims a slot, so a throw here has claimed nothing to release - but
            // it used to abort the whole pass, starving every entry queued behind
            // the throwing one (and, with the slot leak, wedging extraction for
            // good after two throws). Re-arm the entry (R13: a queued follow-up is
            // never discarded) and keep going; the outer catch below still
            // restores the remainder for a throw outside this call.
            nextState.coalesced = true
            coalescedQueue.push(nextId)
            let failedId = 'unknown'
            try { failedId = String(nextId) } catch { /* a hostile id is exactly the failure being reported */ }
            warn('dsh-clawmem: coalesced extraction drain failed for ' + failedId + ': ' + errorMessage(error))
            continue
          }
          scheduled += 1
        }
        // Nothing in this pass could start, so every remaining entry waits on an
        // in-flight run that will itself re-drain on completion: stop, no spin.
        if (scheduled === 0) return
      }
    } catch (error) {
      // R14: restore the entry being processed plus everything after it, in
      // order. The pass cleared the head's coalesced flag before trying to start
      // it, and a throw there means no run was scheduled, so re-arm it - without
      // the flag the next drain would drop it as stale. The loop's own in-flight
      // check still prevents a double run for an entry that did start.
      const remainder = pending.slice(next)
      if (remainder.length > 0) {
        const head = states.get(remainder[0])
        if (head) head.coalesced = true
        for (const id of remainder) coalescedQueue.push(id)
      }
      warn('dsh-clawmem: coalesced extraction drain failed: ' + errorMessage(error))
      return
    }
  }
  function scheduleExtraction(sessionId, state) {
    const coalesce = config.extraction.coalesce
    if (state.inFlight || inFlightRuns >= config.extraction.maxConcurrentJobs) {
      if (coalesce) {
        if (!state.coalesced) { state.coalesced = true; coalescedQueue.push(sessionId) }
        debug('dsh-clawmem: extraction coalesced for ' + sessionId)
      }
      else debug('dsh-clawmem: extraction dropped for ' + sessionId + ' (run in flight, coalesce off)')
      return
    }
    // R15/F1: resolve the transcript path BEFORE the slot is claimed. pathFor
    // throws for a non-string session id whose toString throws, and at the old
    // position (after the counters were raised) that throw left state.inFlight
    // and inFlightRuns set with no finish() registered: the entry never ran and
    // one global slot leaked per throw (two throws wedged extraction for good).
    // Resolved first, a throw claims nothing, so there is no counter to reset.
    // Everything after the claim below is a plain-object assignment or the
    // guarded detach(), and neither can throw.
    const writer = writerFor(sessionId)
    const transcriptPath = writer ? writer.path : pathFor(sessionId)
    state.inFlight = true
    state.coalesced = false
    inFlightRuns += 1
    const finish = function () {
      state.inFlight = false
      inFlightRuns = Math.max(0, inFlightRuns - 1)
      drainCoalesced()
    }
    Promise.resolve(detach(function () { return runExtract(sessionId, transcriptPath) }, 'clawmem-extract ' + sessionId)).then(finish, finish)
  }

  function stateFor(sessionId) {
    let state = states.get(sessionId)
    if (!state) { state = { bootstrap: '', postCompactPending: false, lastExtractAt: 0, newMessages: 0, gateFiredSinceCompaction: false, inFlight: false, coalesced: false }; states.set(sessionId, state) }
    return state
  }
  // DSH exposes lineage on the immutable creation header
  // (packages/core/session/src/index.ts:464, built at :992-1002); the durable
  // session record carries top-level origin/parentSession and no meta field,
  // and the older host shape used session.meta. Support every observed shape,
  // but keep the condition two-part: ONLY subagent origin or parentSession set
  // is excluded (D-10), so no other origin can be excluded by accident.
  function hasSubagentLineage(session) {
    const header = session && session.header
    if (header && (header.origin === 'subagent' || header.parentSession)) return true
    const meta = session && session.meta
    if (meta && (meta.origin === 'subagent' || meta.parentSession)) return true
    return !!(session && (session.origin === 'subagent' || session.parentSession))
  }
  function isSubagent(session) {
    if (config.subagents.policy !== 'exclude') return false
    try { return hasSubagentLineage(session) } catch (error) {
      debug('dsh-clawmem: subagent lineage check failed: ' + errorMessage(error))
      return false
    }
  }
  /** True when the session must be skipped; the skip is logged at debug (6.5). */
  function skipSubagent(session, where) {
    if (!isSubagent(session)) return false
    let id = 'unknown'
    try { id = String((session && session.id) || (session && session.header && session.header.id) || 'unknown') } catch { /* keep 'unknown' */ }
    debug('dsh-clawmem: subagent policy skip (' + where + ') session=' + id)
    return true
  }
  function writerFor(sessionId) {
    try { return transcripts.writerFor(sessionId) } catch (error) { warn('dsh-clawmem: transcript writer failed: ' + errorMessage(error)); return null }
  }
  /** Prefer the client's own single parse (frozen interface) and keep supporting
   *  an older client that only returns stdout. */
  function contextOf(result) {
    if (result && typeof result.context === 'string') return result.context
    return extractContext(result ? result.stdout : undefined)
  }
  /** Log one hook failure with its detail. The client reports whether it already
   *  emitted its own line for this run (result.logged), so a failure is logged
   *  exactly once: the transport keeps the detail, the call-site reason drops to
   *  debug when the client already spoke (F1). An oversized output is the one
   *  client line that is never repeated here. */
  function reportHookFailure(hook, result, why) {
    if (result && result.oversized) return
    const detail = []
    if (result && result.parseIssue) detail.push('parseIssue=' + result.parseIssue)
    if (result && result.timedOut) detail.push('timedOut')
    if (result && result.code !== undefined && result.code !== null) detail.push('exit=' + result.code)
    if (result && result.signal) detail.push('signal=' + result.signal)
    if (result && result.ms !== undefined) detail.push('ms=' + result.ms)
    const line = 'dsh-clawmem: ' + hook + ' failed' + (why ? ' (' + why + ')' : '') + (detail.length ? ' [' + detail.join(', ') + ']' : '')
    if (result && result.logged === true) debug(line)
    else warn(line)
  }
  /**
   * H5: projectedTokens lives ONLY in the client-visible wire view, which
   * snapshot() returns as { asOfSeq, values: { contextPressure: {...} } }
   * (packages/session/session-projection/src/index.ts:338,
   * packages/llm/token-meter/src/usage-projection.ts:208-216). stateOf returns
   * the raw STATE, which has no projectedTokens, so it is only a fallback.
   */
  function pressureView(session) {
    const projections = ctx && ctx.sessionProjections
    if (projections && typeof projections.snapshot === 'function') {
      try {
        const snapshot = projections.snapshot(session)
        const view = snapshot && snapshot.values ? snapshot.values.contextPressure : undefined
        if (isRecord(view)) return { view: view, source: 'wire-view' }
        debug('dsh-clawmem: pressure gate: snapshot has no contextPressure view; falling back to stateOf')
      } catch (error) { debug('dsh-clawmem: pressure gate: snapshot failed (' + errorMessage(error) + '); falling back to stateOf') }
    }
    if (projections && typeof projections.stateOf === 'function') {
      try { return { view: projections.stateOf(session, 'contextPressure'), source: 'stateOf' } } catch (error) { debug('dsh-clawmem: pressure gate: stateOf failed: ' + errorMessage(error)) }
    }
    return { view: undefined, source: 'none' }
  }
  /**
   * N2: normalize the view for the gate and describe the exact branch
   * shouldPrecompact will take, so the debug line can never print a threshold
   * the gate did not use. A raw stateOf view carries contextWindow +
   * pressureTokens but no projectedTokens; the design makes
   * fallbackTriggerTokens the rule only "if projectedTokens/contextWindow are
   * unavailable", so whenever a usable window exists, pressureTokens is the
   * best available proxy for the projected value and the window-scaled ratio
   * applies. Previously this combination fired off the 100000 floor at 13 % of
   * a 1 M window while printing the 640000 threshold it never used.
   */
  function gatePlan(source, view, effective) {
    const raw = isRecord(view) ? view : {}
    const window = finiteNumber(raw.contextWindow)
    const projected = finiteNumber(raw.projectedTokens)
    const current = finiteNumber(raw.pressureTokens)
    const ratio = effective.proximityRatio * effective.compactionThresholdRatio
    if ((projected !== undefined || current !== undefined) && window !== undefined && window > 0) {
      const proxied = projected === undefined
      return {
        pressure: proxied ? Object.assign({}, raw, { projectedTokens: current }) : raw,
        branch: source,
        rule: 'ratio',
        threshold: ratio * window,
        metric: proxied ? 'pressureTokens' : 'projectedTokens',
        value: proxied ? current : projected,
        window: window,
      }
    }
    const floor = effective.fallbackTriggerTokens
    if (projected !== undefined) return { pressure: raw, branch: source, rule: 'fallbackTriggerTokens', threshold: floor, metric: 'projectedTokens', value: projected, window: window }
    if (current !== undefined) return { pressure: raw, branch: source, rule: 'fallbackTriggerTokens', threshold: floor, metric: 'pressureTokens', value: current, window: window }
    return { pressure: raw, branch: source, rule: 'none', threshold: undefined, metric: 'none', value: undefined, window: window }
  }
  /** One truthful description of the branch, the rule and the real threshold. */
  function planText(plan) {
    if (plan.rule === 'none') return 'branch=' + plan.branch + ' rule=none (no pressure metric; no threshold; gate skipped)'
    return 'branch=' + plan.branch + ' rule=' + plan.rule + ' threshold=' + plan.threshold + ' metric=' + plan.metric + '=' + plan.value + (plan.window !== undefined ? ' contextWindow=' + plan.window : '')
  }
  function pathFor(sessionId) {
    try { return transcripts.pathFor(sessionId) } catch (error) {
      // Same documented fallback path as before, but stringified like the
      // transcript manager does, so the fallback itself cannot throw on a
      // non-string session id (D-18 fail-open).
      debug('dsh-clawmem: transcript pathFor failed: ' + errorMessage(error))
      return join(config.transcript.dir, String(sessionId), 'transcript.jsonl')
    }
  }
  async function userMessage(text) {
    if (!createUserMessageFn) { const mod = await resolveDshModule('@deepseek-ai/dsh-llm'); createUserMessageFn = mod.createUserMessage }
    // Session format v4 refuses the retired catch-all `kind: 'plugin'` on a durable
    // message; the producer owns its kind, and `plugin:<name>` is the spelling the
    // v3->v4 migration writes for a former plugin wrapper.
    return createUserMessageFn({ content: [{ type: 'text', text: text }], source: { kind: 'plugin:' + name, form: 'snapshot', sections: [{ name: name, text: text }] } })
  }
  /**
   * L7: ClawMem's precompact-extract writes
   * dirname(transcript_path)/memory/precompact-state.md only when that directory
   * already exists (clawmem src/hooks/precompact-extract.ts:29-43); otherwise it
   * writes nothing and logs nothing, so the compaction/start fallback could log
   * "fallback precompact-extract" with no state file produced - and the
   * post-compaction inject then finds nothing to inject. Create the directory
   * first. Fail-open: a failed mkdir warns and the hook is still attempted.
   */
  function ensurePrecompactMemoryDir(transcriptPath) {
    // The transcript-manager fallback stub returns '' when no manager could be
    // built; dirname('') is '.', so mkdir would create ./memory in the host CWD.
    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return
    try { mkdirSync(join(dirname(transcriptPath), 'memory'), { recursive: true }) }
    catch (error) { warn('dsh-clawmem: could not create the precompact memory directory for ' + transcriptPath + ': ' + errorMessage(error)) }
  }
  async function runPrecompact(sessionId, reason) {
    try {
      const writer = writerFor(sessionId)
      const transcriptPath = writer ? writer.path : pathFor(sessionId)
      ensurePrecompactMemoryDir(transcriptPath)
      const result = await client.runHook('precompact-extract', { session_id: clawmemSessionId(sessionId), transcript_path: transcriptPath }, config.precompact.timeoutMs)
      if (!result || !result.ok) reportHookFailure('precompact-extract', result, reason)
    } catch (error) { warn('dsh-clawmem: precompact-extract error (' + reason + '): ' + errorMessage(error)) }
  }
  async function runExtract(sessionId, transcriptPath) {
    const hooks = config.extraction.hooks || []
    const input = { session_id: clawmemSessionId(sessionId), transcript_path: transcriptPath }
    const results = await Promise.allSettled(hooks.map(function (hook) { return client.runHook(hook, input, config.extraction.timeoutMs) }))
    results.forEach(function (result, i) {
      if (result.status === 'rejected') warn('dsh-clawmem: ' + hooks[i] + ' rejected: ' + errorMessage(result.reason))
      else if (!result.value || result.value.ok === false) reportHookFailure(hooks[i], result.value, 'per-turn extraction')
    })
  }

  listen('session/event', function (session, event) {
    try {
      if (!session || !event || skipSubagent(session, 'session/event')) return
      const sessionId = session.id
      const state = stateFor(sessionId)
      const writer = writerFor(sessionId)
      if (writer) {
        if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') { writer.appendUser(userTextOf(userContentOf(event))); state.newMessages += 1 }
        else if (event.type === 'assistant/message' && event.data && event.data.message) { writer.appendAssistant(event.data.message.content); state.newMessages += 1 }
        else if (event.type === 'tool/call' && event.data) { writer.appendToolCall({ callId: event.data.callId, name: event.data.name, arguments: event.data.arguments }) }
        else if (event.type === 'tool/result' && event.data && event.data.message && Array.isArray(event.data.message.content) && event.data.message.content.length > 0) {
          // L5: a tool result may carry several blocks; emit them all, take the
          // toolCallId from the first block that has one, and mark the result as
          // an error when any block is one.
          const blocks = event.data.message.content
          let callId
          for (const block of blocks) {
            if (block && block.toolCallId !== undefined && block.toolCallId !== null) { callId = block.toolCallId; break }
          }
          const text = blocks.map(blockTextOf).filter(Boolean).join(LF)
          const isError = blocks.some(function (block) { return !!(block && block.isError) })
          writer.appendToolResult({ callId: callId, content: text, isError: isError })
        }
      }
      if (event.type === 'compaction/end' && event.data && !event.data.error) {
        state.postCompactPending = true
        state.gateFiredSinceCompaction = false
      }
      // M5: the fallback only covers the case the pressure gate could not see
      // (6.2 "fallback to run precompact-extract if the pressure gate did not fire").
      if (event.type === 'compaction/start' && config.precompact.enabled && config.precompact.fallbackOnCompactionStart) {
        if (state.gateFiredSinceCompaction) {
          state.gateFiredSinceCompaction = false
          debug('dsh-clawmem: compaction/start fallback skipped for ' + sessionId + ' (pressure gate already fired)')
        } else {
          debug('dsh-clawmem: compaction/start fallback precompact-extract for ' + sessionId)
          void runPrecompact(sessionId, 'fallback')
        }
      }
    } catch (error) { warn('dsh-clawmem: session/event handling failed: ' + errorMessage(error)) }
  })

  listen('agent/created', function (payload) {
    try {
      const source = payload && payload.source
      if (source !== undefined && source !== 'startup') return
      const agent = payload && payload.agent
      if (!agent || skipSubagent(agent.session, 'agent/created')) return
      const sessionId = agent.session.id
      const state = stateFor(sessionId)
      void (async function () {
        const parts = []
        const bootstrapHooks = []
        if (config.bootstrap.sessionBootstrap) bootstrapHooks.push('session-bootstrap')
        if (config.bootstrap.curatorNudge) bootstrapHooks.push('curator-nudge')
        if (config.bootstrap.stalenessCheck) bootstrapHooks.push('staleness-check')
        for (const hook of bootstrapHooks) {
          const result = await client.runHook(hook, { session_id: clawmemSessionId(sessionId) })
          if (!result || !result.ok) { reportHookFailure(hook, result, 'created'); continue }
          const context = contextOf(result)
          if (context) parts.push(context)
        }
        if (parts.length) state.bootstrap = parts.join(DOUBLE)
      })().catch(function (error) { warn('dsh-clawmem: created hooks failed: ' + errorMessage(error)) })
    } catch (error) { warn('dsh-clawmem: created handling failed: ' + errorMessage(error)) }
  })

  listen('agent/pre-step', async function (payload, next) {
    const agent = payload && payload.agent
    const parts = []
    try {
      if (agent && !skipSubagent(agent.session, 'agent/pre-step')) {
        const sessionId = agent.session.id
        const state = stateFor(sessionId)
        const promptText = (payload.messages || []).map(function (m) { return textOf(m.content) }).join(LF).trim()
        if (state.bootstrap) { parts.push(state.bootstrap); state.bootstrap = '' }
        if (config.surfacing.enabled && promptText.length >= config.surfacing.minPromptChars) {
          const result = await client.runHook('context-surfacing', { session_id: clawmemSessionId(sessionId), prompt: promptText }, config.surfacing.timeoutMs)
          if (!result || !result.ok) reportHookFailure('context-surfacing', result, 'pre-step')
          else {
            const context = contextOf(result)
            if (context) parts.push(context)
          }
        }
        if (config.precompact.enabled) {
          const ratio = resolveCompactionThresholdRatio(ctx, config.precompact.compactionThresholdRatio)
          const effective = Object.assign({}, config.precompact, { compactionThresholdRatio: ratio })
          const pressureInfo = pressureView(agent.session)
          const plan = gatePlan(pressureInfo.source, pressureInfo.view, effective)
          let fire = false
          try { fire = shouldPrecompact({ pressure: plan.pressure, config: effective }) } catch (error) { warn('dsh-clawmem: pressure gate evaluation failed: ' + errorMessage(error)) }
          if (fire) {
            state.gateFiredSinceCompaction = true
            debug('dsh-clawmem: pressure gate fired (' + planText(plan) + ')')
            await runPrecompact(sessionId, 'gate')
          } else {
            debug('dsh-clawmem: pressure gate skip: ' + (plan.rule === 'none' ? planText(plan) : 'below ' + planText(plan)))
          }
        }
        // M4: the authoritative post-compaction context must not be lost when the
        // hook fails or times out, so clear the flag only on a successful run.
        if (config.postcompact.enabled && state.postCompactPending) {
          // Change 3/HIGH: postcompact-inject.ts:36-46 locates the authoritative
          // pre-compaction state at dirname(transcript_path)/memory/precompact-state.md
          // (:71). Without transcript_path it fell back to a CWD-derived ~/.claude
          // path that does not exist for DSH, so Section 1 was silently never
          // injected. Send the same path precompact-extract wrote.
          const postWriter = writerFor(sessionId)
          const postTranscriptPath = postWriter ? postWriter.path : pathFor(sessionId)
          const result = await client.runHook('postcompact-inject', { session_id: clawmemSessionId(sessionId), transcript_path: postTranscriptPath })
          if (result && result.ok) {
            state.postCompactPending = false
            const context = contextOf(result)
            if (context) parts.push(context)
          } else {
            reportHookFailure('postcompact-inject', result, 'pending kept')
          }
        }
      }
    } catch (error) { warn('dsh-clawmem: pre-step collection failed: ' + errorMessage(error)) }
    // F7a: the plugin must log a downstream failure, but never swallow it -
    // the loop still has to see the rejection.
    let downstream
    try { downstream = await next() } catch (error) {
      warn('dsh-clawmem: pre-step next() failed: ' + errorMessage(error))
      throw error
    }
    if (!parts.length || downstream.kind !== 'enter') return downstream
    try {
      const message = await userMessage(parts.join(DOUBLE))
      return Object.assign({}, downstream, { messages: downstream.messages.concat([message]) })
    } catch (error) { warn('dsh-clawmem: pre-step injection failed: ' + errorMessage(error)); return downstream }
  }, { prepend: true })

  listen('agent/turn-stopping', async function (payload) {
    try {
      const agent = payload && payload.agent
      if (!agent || !config.extraction.enabled || skipSubagent(agent.session, 'agent/turn-stopping')) return
      const sessionId = agent.session.id
      const state = stateFor(sessionId)
      if (state.newMessages < config.extraction.minNewMessages) {
        debug('dsh-clawmem: extraction skip for ' + sessionId + ' (only ' + state.newMessages + ' new message(s))')
        return
      }
      const now = Date.now()
      const forced = config.extraction.forceBeforeCompaction && state.gateFiredSinceCompaction
      if (!forced && now - state.lastExtractAt < config.extraction.minIntervalMs) {
        debug('dsh-clawmem: extraction throttled for ' + sessionId + ' (minIntervalMs=' + config.extraction.minIntervalMs + ')')
        return
      }
      if (forced) state.gateFiredSinceCompaction = false
      state.lastExtractAt = now
      state.newMessages = 0
      scheduleExtraction(sessionId, state)
    } catch (error) { warn('dsh-clawmem: turn-stopping handling failed: ' + errorMessage(error)) }
  }, { serial: true })

  try {
    if (config.skill.register && ctx.skills && typeof ctx.skills.register === 'function') {
      // R-2: use the binary the hook client actually resolved (it may be auto).
      // R3 #12: only derive a package root from an ABSOLUTE path. A bare name like
      // clawmem is not a path: realpathSync fails, dirname('.') walks to the parent of
      // the process cwd, and an unrelated SKILL.md could be registered as the skill.
      // A package root is derived only from a PATH-SHAPED value that resolves to a regular
      // file: a bare name is not a path, and a directory must never let dirname() walk to an
      // unrelated SKILL.md. A relative but real path still counts (resolved against cwd).
      const binResolved = client && typeof client.bin === 'string' ? client.bin : ''
      const pathShaped = binResolved !== '' && (isAbsolute(binResolved) || binResolved.includes('/'))
      const binAbsolute = pathShaped && !isAbsolute(binResolved) ? resolve(binResolved) : binResolved
      if (!pathShaped || !isRegularFile(binAbsolute)) {
        warn('dsh-clawmem: skill registration skipped: no clawmem binary file resolved (got ' + (binResolved || 'none') + '; set clawmemBin or $CLAWMEM_BIN to an existing file)')
      } else {
        let binReal = binAbsolute
        try { binReal = realpathSync(binAbsolute) } catch { binReal = binAbsolute }
        const packageRoot = resolve(dirname(binReal), '..')
        const skillPath = join(packageRoot, 'SKILL.md')
        if (existsSync(skillPath)) {
          const parsed = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
          const definition = { name: config.skill.name, source: SKILL_SOURCE, description: parsed.description || 'ClawMem operational reference', content: parsed.body, resourceBase: { kind: 'directory', path: packageRoot } }
          registerDisposable('clawmem:skills.register()', function () { return ctx.skills.register(definition) })
        } else { warn('dsh-clawmem: ClawMem SKILL.md not found at ' + skillPath) }
      }
    }
  } catch (error) { warn('dsh-clawmem: skill registration failed: ' + errorMessage(error)) }

  try {
    if (config.routingBlock.mode === 'section' && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      const blockPath = join(PLUGIN_DIR, 'routing-block.dsh.md')
      if (existsSync(blockPath)) {
        const section = { name: 'clawmem:routing', order: 300, text: readFileSync(blockPath, 'utf8') }
        registerDisposable('clawmem:systemPrompt.section', function () { return ctx.systemPrompt.section(section) })
      }
      else warn('dsh-clawmem: routing block missing at ' + blockPath)
    }
  } catch (error) { warn('dsh-clawmem: routing section registration failed: ' + errorMessage(error)) }

  if (config.transcript.rotation.enabled) {
    registerDisposable('clawmem:rotation', function () {
      // L2: a process restarted more often than sweepIntervalHours would never
      // prune, so run one guarded sweep at activation and keep the interval.
      try { transcripts.sweep() } catch (error) { warn('dsh-clawmem: sweep failed: ' + errorMessage(error)) }
      const interval = Math.max(1, config.transcript.rotation.sweepIntervalHours) * 3600000
      let timer
      try {
        timer = setInterval(function () { try { transcripts.sweep() } catch (error) { warn('dsh-clawmem: sweep failed: ' + errorMessage(error)) } }, interval)
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch (error) { warn('dsh-clawmem: rotation setup failed: ' + errorMessage(error)); return undefined }
      return function () { try { clearInterval(timer) } catch { /* already gone */ } }
    })
  }

  // M3: transcripts.close() must run on disposal.
  registerDisposable('clawmem:transcripts.close()', function () {
    return function () { try { transcripts.close() } catch (error) { warn('dsh-clawmem: transcript close failed: ' + errorMessage(error)) } }
  })

  info('dsh-clawmem: ready (bin=' + ((client && client.bin) || 'unresolved') + ' via ' + ((client && client.binSource) || 'n/a') + ', profile=' + config.profile + ')')

  /** Tear down every registration this apply() made (Cordis effect or not). */
  function dispose() {
    const pending = collected.splice(0).reverse()
    for (const disposer of pending) {
      try { disposer() } catch (error) { warn('dsh-clawmem: disposal failed: ' + errorMessage(error)) }
    }
  }
  return dispose
}

