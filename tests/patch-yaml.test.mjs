// Regression guard for cordis.patch.yml - the bundle overlay whose YAML parse failure
// took dsh-web.service down on 2026-09-21 (an UNQUOTED plain scalar containing a
// space-colon-space: 60 restarts, 14:07:38-14:19:31).
//
// Two layers:
//   1. a dependency-free lint that ALWAYS runs: unquoted ': ', a !!js value that is not
//      a single quoted scalar, a quoted value with trailing content, tab indentation, a
//      top-level entry that is not a mapping, and CRLF;
//   2. the loader's own dialect - js-yaml with yaml.JSON_SCHEMA.extend(JsExpr), exactly
//      as vendor/include mounts it - plus the loader's structural contract (a top-level
//      array whose every entry is a mapping, and every insert row a mapping with an id).
// Each layer is proven by a control: the incident revision, a non-mapping entry, a baked
// in machine path, and a !!js value that parses to a mapping instead of a scalar.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH_PATH = resolve(HERE, '..', 'cordis.patch.yml')
const PATCH_RAW = readFileSync(PATCH_PATH, 'utf8')
const PATCH = PATCH_RAW.replace(/\r\n?/g, '\n')

// The revision that broke the boot, verbatim.
const INCIDENT_LINE = "        command: !!js process.env.CLAWMEM_BIN || (process.env.HOME ? process.env.HOME + '/.npm-global/bin/clawmem' : 'clawmem')"

// ---------------------------------------------------------------- lint layer

/**
 * Walk one line once and report where its comment starts (-1 when there is none) and how many ': '
 * separators sit outside quotes. YAML's quoting rules are respected, which matters: inside a DOUBLE-quoted
 * scalar a backslash escapes the next character, while inside a SINGLE-quoted scalar a backslash is literal
 * and two consecutive quotes are an escaped quote. Treating a backslash as an escape in single quotes made a
 * fatal line look safe and a legal line look fatal (re-audit N2).
 */
function scanLine(line) {
  let quote = null
  let separators = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote === '"') {
      if (ch === '\\') { i += 1; continue }
      if (ch === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (ch === "'") {
        if (line[i + 1] === "'") { i += 1; continue }
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return { commentAt: i, separators }
    if (ch === ':' && (i + 1 === line.length || /\s/.test(line[i + 1]))) separators += 1
  }
  return { commentAt: -1, separators }
}

/** Strip a trailing YAML comment: a '#' outside quotes and preceded by whitespace. */
function stripTrailingComment(value) {
  const at = scanLine(value).commentAt
  return at < 0 ? value : value.slice(0, at).trim()
}

/** Count ': ' separators OUTSIDE quotes: a plain scalar may carry at most one (M4/M5). */
function separatorCount(line) {
  return scanLine(line).separators
}

/** Peel "key:" and a leading "!!tag ", returning the scalar and whether it was tagged. */
function keyAndValue(line) {
  const m = /^(\s*)"?([A-Za-z0-9_.-]+)"?:(\s*)(.*)$/.exec(line)
  if (!m) return null
  const raw = stripTrailingComment(m[4])
  const tagged = /^!!([A-Za-z0-9_-]+)\s+(.*)$/.exec(raw)
  if (tagged) return { key: m[2], value: tagged[2].trim(), tagged: true }
  return { key: m[2], value: raw.trim(), tagged: false }
}

/** True only for a single, fully quoted scalar - '"x" "a : b"' is not one. */
function isQuotedScalar(value) {
  return /^"(?:[^"\\]|\\.)*"$/.test(value) || /^'(?:[^']|'')*'$/.test(value)
}

/** Why this line would break the loader, or null when it is safe. */
function yamlHazard(line) {
  if (/^\s*\t/.test(line) || /:\s*\t/.test(line)) return 'tab in indentation or after a colon (YAML forbids tabs)'
  const item = /^-\s+(.*)$/.exec(line)
  if (item && !/^[A-Za-z0-9_.-]+:(\s|$)/.test(item[1])) return 'top-level list entry is not a mapping'
  const entry = keyAndValue(line)
  if (!entry || entry.value === '') {
    // M4: a key outside [A-Za-z0-9_.-] still counts - the separator rule must not depend on it.
    if (separatorCount(stripTrailingComment(line)) > 1) return 'unquoted scalar contains a space-colon-space (a YAML mapping separator)'
    return null
  }
  if (entry.tagged && !isQuotedScalar(entry.value)) return 'a !!js value must be a single quoted scalar'
  if (isQuotedScalar(entry.value)) return null
  if (/^["']/.test(entry.value)) return 'quoted value carries trailing content'
  // M5: a ': ' INSIDE a quoted literal is content, not a separator.
  if (separatorCount(stripTrailingComment(line)) > 1) return 'unquoted scalar contains a space-colon-space (a YAML mapping separator)'
  return null
}

function lintHazards(text) {
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map((line, i) => [i + 1, yamlHazard(line)])
    .filter((entry) => entry[1])
}

/** The expression text of one "key: !!js ..." line, with the YAML quoting removed. */
function expressionText(line) {
  const raw = /^\s*"?[A-Za-z0-9_.-]+"?\s*:\s*!!js\s+(.*)$/.exec(line)
  if (!raw) return null
  const value = stripTrailingComment(raw[1].trim())
  return isQuotedScalar(value) ? value.slice(1, -1) : value
}

/** The text of a trailing YAML comment on a "key: !!js ..." line, or '' when there is none. */
function trailingComment(line) {
  const raw = /^\s*"?[A-Za-z0-9_.-]+"?\s*:\s*!!js\s+(.*)$/.exec(line)
  if (!raw) return ''
  const body = raw[1].trim()
  return body.slice(stripTrailingComment(body).length)
}

/** The text of a full-line YAML comment, or '' when the line is not one. */
function fullLineComment(line) {
  const match = /^\s*#\s?(.*)$/.exec(line)
  return match ? match[1] : ''
}

/**
 * Every slash-leading string literal in the file's config expressions OR in any comment. A comment is inert
 * YAML but it still ships, so a path written there must stay visible - whether it trails a value or sits on
 * a line of its own (re-audit finding 4). Comments are scanned on their own, because keeping one inside the
 * expression would let an outer quoted scalar swallow the inner literals.
 */
function absoluteLiterals(text) {
  const found = new Set()
  const collect = (fragment) => {
    if (!fragment) return
    for (const literal of fragment.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || []) {
      const inner = literal.slice(1, -1)
      if (inner.startsWith('/')) found.add(inner)
    }
    for (const bare of fragment.match(/(?:^|\s)(\/[^\s'"]+)/g) || []) found.add(bare.trim())
  }
  for (const line of text.split('\n')) {
    const expression = expressionText(line)
    if (expression !== null) {
      const whole = expression.trim()
      if (/^\/[^\s'"]+$/.test(whole)) found.add(whole)
      collect(expression)
    }
    collect(trailingComment(line))
    collect(fullLineComment(line))
  }
  return found
}

// ------------------------------------------------------------ loader dialect

function loaderSchema(parser) {
  // Exactly what vendor/include mounts: JSON_SCHEMA plus the !!js scalar tag.
  return parser.JSON_SCHEMA.extend([new parser.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })])
}

function loadJsYaml() {
  const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
  for (const base of [join(HERE, '..', 'package.json'), join(home, 'profiles/web/package.json'), join(home, 'profiles/package.json')]) {
    try { return createRequire(base)('js-yaml') } catch { /* next base */ }
  }
  return null
}

const jsyaml = loadJsYaml()

function parseWithLoader(text) {
  return jsyaml.load(text, { schema: loaderSchema(jsyaml) })
}

/** The loader's structural contract. */
function structuralErrors(doc) {
  if (!Array.isArray(doc)) return ['the patch must be a top-level YAML array (got ' + typeof doc + ')']
  const problems = []
  const seen = new Set()
  doc.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { problems.push('entry ' + i + ' must be a mapping'); return }
    if (entry.insert === undefined) return
    if (!Array.isArray(entry.insert)) { problems.push('entry ' + i + ' insert must be a list'); return }
    entry.insert.forEach((row, j) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || row.id === '') {
        problems.push('entry ' + i + ' insert[' + j + '] must be a mapping with an id'); return
      }
      // The loader auto-assigns a missing id but ALWAYS needs a name (Entry._init calls
      // tree.import(options.name), which throws on undefined) and refuses a duplicate id
      // anywhere in the composed entry list - both are boot-fatal.
      if (typeof row.name !== 'string' || row.name === '') problems.push('entry ' + i + ' insert[' + j + '] (' + row.id + ') must carry a non-empty name')
      if (seen.has(row.id)) problems.push('duplicate loader entry id: ' + row.id)
      else seen.add(row.id)
      // Field types the plugin schemas require, checked on EVERY row in EVERY entry: an
      // appended row with args as a string or command as a number is boot-fatal and used to
      // slip past because only the first row was inspected.
      const isExpression = (v) => v !== null && typeof v === 'object' && typeof v.__jsExpr === 'string'
      const config = row.config
      if (config !== undefined) {
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          problems.push('entry ' + i + ' insert[' + j + '] config must be a mapping')
        } else {
          if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((arg) => typeof arg === 'string'))) problems.push('entry ' + i + ' insert[' + j + '] config.args must be a list of strings')
          for (const key of ['serverName', 'transport', 'command', 'cwd']) {
            const value = config[key]
            if (value !== undefined && typeof value !== 'string' && !isExpression(value)) problems.push('entry ' + i + ' insert[' + j + '] config.' + key + ' must be a string or a !!js expression')
          }
        }
      }
    })
  })
  return problems
}

// ------------------------------------------------------------------- tests

test('lint: the detector catches every YAML-fatal shape the incident and its mutants took', () => {
  assert.notEqual(yamlHazard(INCIDENT_LINE), null, 'the incident revision must be flagged')
  assert.match(yamlHazard('        serverName: a : b') || '', /space-colon-space/, 'an unquoted plain scalar hazard is named precisely')
  assert.match(yamlHazard('        command: !!js process.env.HOME') || '', /quoted scalar/)
  assert.match(yamlHazard('\tcommand: clawmem') || '', /tab/)
  assert.match(yamlHazard('        command:\ta : b') || '', /tab/)
  assert.match(yamlHazard('- just-a-string') || '', /not a mapping/)
  assert.match(yamlHazard('        command: "x" "a : b"') || '', /trailing content|: /)
  assert.match(yamlHazard('        command: "a" : "b"') || '', /trailing content|: /)
  assert.equal(yamlHazard('- insert:'), null)
  assert.equal(yamlHazard('        cwd: !!js "process.cwd()"'), null)
  assert.equal(yamlHazard('        serverName: clawmem'), null)
  assert.equal(yamlHazard("        args: ['mcp']"), null)
  assert.equal(yamlHazard('  # a commented hazard: a : b'), null)
})

test('lint: the shipped cordis.patch.yml has no hazard', () => {
  assert.deepEqual(lintHazards(PATCH), [], 'offending lines: ' + JSON.stringify(lintHazards(PATCH)))
})

test('lint: the shipped file is LF only (CRLF would make the line lint inert)', () => {
  assert.equal(PATCH_RAW.includes('\r'), false, 'cordis.patch.yml must stay LF-only')
})

test('the only slash-leading config literal is the $HOME-relative npm-global suffix', () => {
  assert.deepEqual([...absoluteLiterals(PATCH)], ['/.npm-global/bin/clawmem'],
    'the only slash-leading literal may be the npm-global suffix that is appended to $HOME')
  assert.deepEqual([...absoluteLiterals('        command: !!js "/opt/local/clawmem"')], ['/opt/local/clawmem'],
    'control: a baked-in absolute path must be visible to the property')
  assert.deepEqual([...absoluteLiterals('        cwd: !!js "process.cwd()"')], [],
    'a path-free expression contributes nothing')
})

test('cordis.patch.yml parses in the loader dialect and satisfies its structure', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const doc = parseWithLoader(PATCH)
  assert.deepEqual(structuralErrors(doc), [], 'loader structural contract')
  assert.deepEqual(doc[0].insert.map((row) => row.id), ['memory-clawmem', 'dsh-clawmem'])
  const mcp = doc[0].insert[0]
  assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(mcp.config.serverName, 'clawmem')
  assert.equal(mcp.config.transport, 'stdio')
  assert.deepEqual(mcp.config.args, ['mcp'])
  assert.equal(typeof mcp.config.command.__jsExpr, 'string', 'the !!js tag yields an expression, not a literal')
  assert.equal(typeof mcp.config.cwd.__jsExpr, 'string')
  // The row's plain fields must keep the types the mcp-client schema accepts, so a typo such as
  // 'command: 42' or a non-list args cannot ride along unnoticed.
  assert.equal(typeof mcp.config.serverName, 'string')
  assert.equal(typeof mcp.config.transport, 'string')
  assert.ok(Array.isArray(mcp.config.args) && mcp.config.args.every((arg) => typeof arg === 'string'))
  assert.equal(typeof doc[0].insert[1].name, 'string', 'the plugin row carries a name')
})

test('control: the structural contract rejects a non-mapping entry (loader-fatal)', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const doc = parseWithLoader(PATCH + '- just-a-string\n')
  const problems = structuralErrors(doc)
  assert.equal(problems.length, 1, 'a bare string entry must be reported: ' + JSON.stringify(problems))
  assert.match(problems[0], /must be a mapping/)
  assert.notEqual(yamlHazard('- just-a-string'), null, 'the dependency-free lint flags it too')
})

// The property checks above are textual, so an expression can be rewritten in a spelling they do
// not model (bracket access, (0,eval), new Function, a multi-line scalar). Pinning the SET of
// expressions the parsed document actually carries closes the whole class: any addition, removal
// or rewrite must be a deliberate, reviewed change.
const EXPECTED_EXPRESSIONS = [
  "(process.env.CLAWMEM_BIN || '').trim() || (process.env.HOME ? process.env.HOME + '/.npm-global/bin/clawmem' : 'clawmem')",
  'process.cwd()',
]

/** Every !!js expression in a parsed document, in traversal order. */
function configExpressions(doc) {
  const found = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (typeof node.__jsExpr === 'string') { found.push(node.__jsExpr); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    for (const key of Object.keys(node)) walk(node[key])
  }
  walk(doc)
  return found
}

/** True when a parsed document carries exactly the reviewed expression set. */
function expressionPinHolds(doc) {
  return JSON.stringify(configExpressions(doc).slice().sort()) === JSON.stringify(EXPECTED_EXPRESSIONS.slice().sort())
}

/** Replace one scalar line, emitting a safely double-quoted !!js scalar. */
function withExpression(patch, key, expression) {
  const re = new RegExp('^(\\s*)' + key + ': .*$', 'm')
  if (!re.test(patch)) throw new Error('no ' + key + ' line to replace')
  return patch.replace(re, '$1' + key + ': !!js ' + JSON.stringify(expression))
}

test('the file carries exactly the expected config expressions', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  assert.equal(expressionPinHolds(parseWithLoader(PATCH)), true, 'a changed, added or removed config expression must be deliberate')
})

test('control: the expression pin rejects every rewrite the audits tried', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const VECTORS = [
    ['M1 a command branching on process["env"]["PATH"]', (patch) => withExpression(patch, 'command', "process.env['PATH'] ? '/usr/bin/clawmem' : 'clawmem'")],
    ['M3 a cwd routed through eval()', (patch) => withExpression(patch, 'cwd', "eval('process.cwd()')")],
    ['M4 a cwd routed through new Function()', (patch) => withExpression(patch, 'cwd', "new Function('return process.cwd()')()")],
    ['M7 an object-valued command conditional on SHELL', (patch) => withExpression(patch, 'command', "process.env.SHELL ? {} : 'clawmem'")],
    ['M8b a multi-line !!js block scalar (the expression pin, not the per-line lint, rejects it)', (patch) => {
      const re = /^\s*cwd: .*$/m
      if (!re.test(patch)) throw new Error('no cwd line to replace')
      return patch.replace(re, '        cwd: !!js >-\n          process\n            .cwd()')
    }],
  ]
  const escaped = []
  for (const [name, mutate] of VECTORS) {
    const mutant = mutate(PATCH)
    assert.notEqual(mutant, PATCH, name + ': the control must change the file')
    let pinned = true
    try { pinned = expressionPinHolds(parseWithLoader(mutant)) } catch { pinned = false }
    if (pinned) escaped.push(name)
  }
  assert.deepEqual(escaped, [], 'these expression rewrites passed the pin: ' + JSON.stringify(escaped))
  assert.equal(VECTORS.length, 5, 'the five audited rewrites are all present')
})

test('the shipped patch is pinned to its exact shape: one entry, two named rows', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const doc = parseWithLoader(PATCH)
  assert.equal(doc.length, 1, 'the shipped patch is a single entry - a second one must be a deliberate, reviewed change')
  assert.deepEqual(doc[0].insert.map((row) => row.id + '|' + row.name), [
    'memory-clawmem|@deepseek-ai/dsh-mcp-client',
    'dsh-clawmem|dsh-clawmem',
  ], 'ids AND module names are pinned: a typo in a name is boot-fatal (ERR_MODULE_NOT_FOUND)')
})

test('no absolute machine path survives anywhere in the parsed document', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const allowed = new Set(['/.npm-global/bin/clawmem'])
  const collect = (node, into) => {
    if (typeof node === 'string') { if (node.startsWith('/') && !allowed.has(node)) into.push(node); return }
    if (Array.isArray(node)) { node.forEach((value) => collect(value, into)); return }
    if (node && typeof node === 'object') { for (const key of Object.keys(node)) collect(node[key], into) }
  }
  const shipped = []; collect(parseWithLoader(PATCH), shipped)
  assert.deepEqual(shipped, [], 'absolute literals found: ' + JSON.stringify(shipped))
  const mutant = PATCH + "- insert:\n    - id: extra\n      name: x\n      config:\n        serverName: extra\n        transport: stdio\n        args: ['mcp']\n        command: /opt/local/clawmem\n"
  const control = []; collect(parseWithLoader(mutant), control)
  assert.deepEqual(control, ['/opt/local/clawmem'], 'control: a baked plain-string path must be caught')
})

/** Fields whose schema wants a string, so a !!js value for them must evaluate to one. */
const STRING_FIELDS = new Set(['command', 'cwd', 'serverName', 'transport'])

/** Every problem found by evaluating each !!js value under the loader's stand-ins. */
function expressionWalkProblems(doc) {
  const standIns = [
    { env: {}, cwd: () => '/cwd' },
    { env: { CLAWMEM_BIN: '/opt/cm/clawmem', HOME: '/home/u' }, cwd: () => '/cwd' },
    { env: { HOME: '/home/u', PATH: '/tools' }, cwd: () => '/cwd' },
  ]
  const problems = []
  let evaluated = 0
  const walk = (node, where, key) => {
    if (node === null || typeof node !== 'object') return
    if (typeof node.__jsExpr === 'string') {
      evaluated += 1
      for (const standIn of standIns) {
        try {
          const value = new Function('process', 'return (' + node.__jsExpr + ')')(standIn)
          // Objects are never interpolatable; a field the schema types as a string must not
          // receive a number, boolean, undefined or function either (X2).
          if (value !== null && typeof value === 'object') problems.push(where + ' evaluates to ' + typeof value)
          else if (STRING_FIELDS.has(key) && typeof value !== 'string') problems.push(where + ' must evaluate to a string, got ' + typeof value)
        } catch (error) { problems.push(where + ' threw ' + error.message) }
      }
      return
    }
    if (Array.isArray(node)) { node.forEach((value, i) => walk(value, where + '[' + i + ']', key)); return }
    for (const childKey of Object.keys(node)) walk(node[childKey], where + '.' + childKey, childKey)
  }
  walk(doc, '$', '')
  return { problems, evaluated }
}

test('every !!js value evaluates to the type its field requires', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const { problems, evaluated } = expressionWalkProblems(parseWithLoader(PATCH))
  assert.ok(evaluated >= 2, 'the walk must actually evaluate the shipped expressions, not pass vacuously (evaluated ' + evaluated + ')')
  assert.deepEqual(problems, [], 'a !!js value the loader cannot interpolate: ' + JSON.stringify(problems))
})

test('control: the walk rejects a non-string and an object-valued expression', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const badCwd = PATCH.replace(/^\s*cwd: .*$/m, '        cwd: !!js "1"')
  assert.notEqual(badCwd, PATCH, 'the control must change the file')
  assert.ok(expressionWalkProblems(parseWithLoader(badCwd)).problems.some((p) => /cwd must evaluate to a string/.test(p)), 'a numeric cwd must be caught')
  const badEnv = PATCH.replace(/^\s*command: .*$/m, '        command: !!js "process.env[\'PATH\'] ? {} : \'clawmem\'"')
  assert.ok(expressionWalkProblems(parseWithLoader(badEnv)).problems.some((p) => /evaluates to object|must evaluate to a string/.test(p)), 'a PATH-conditional object must be caught by the PATH stand-in')
})

test('the shipped patch keeps its shape even without a YAML parser', () => {
  const ids = PATCH.split('\n').filter((line) => /^\s*-\s*id:/.test(line)).map((line) => line.replace(/^\s*-\s*id:\s*/, '').trim().replace(/^["']|["']$/g, ''))
  assert.deepEqual(ids, ['memory-clawmem', 'dsh-clawmem'], 'exactly the two expected rows, in order')
  assert.equal(PATCH.split('\n').filter((line) => /command:\s*!!js\s/.test(line)).length, 1, 'exactly one command expression')
  assert.equal(PATCH_RAW.includes('\r'), false)
})

test('control: duplicate ids and nameless rows are rejected as the loader rejects them', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const dup = structuralErrors(parseWithLoader(PATCH + '- insert:\n    - id: dsh-clawmem\n      name: dsh-clawmem\n'))
  assert.ok(dup.some((p) => /duplicate loader entry id: dsh-clawmem/.test(p)), 'duplicate id: ' + JSON.stringify(dup))
  const nameless = structuralErrors(parseWithLoader(PATCH + '- insert:\n    - id: nameless\n'))
  assert.ok(nameless.some((p) => /non-empty name/.test(p)), 'nameless row: ' + JSON.stringify(nameless))
})

test('control: the field-type rules report the exact problem', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const extraRow = (body) => '- insert:\n    - id: extra\n      name: x\n' + body
  const argsProblem = structuralErrors(parseWithLoader(PATCH + extraRow('      config:\n        args: mcp\n')))
  assert.ok(argsProblem.some((p) => /config.args must be a list of strings/.test(p)), JSON.stringify(argsProblem))
  const typeProblem = structuralErrors(parseWithLoader(PATCH + extraRow('      config:\n        command: 42\n')))
  assert.ok(typeProblem.some((p) => /config.command must be a string or a !!js expression/.test(p)), JSON.stringify(typeProblem))
  const configProblem = structuralErrors(parseWithLoader(PATCH + extraRow('      config: nope\n')))
  assert.ok(configProblem.some((p) => /config must be a mapping/.test(p)), JSON.stringify(configProblem))
})

test('control: a quoted key cannot hide a machine path', () => {
  assert.deepEqual([...absoluteLiterals('        "cwd": !!js "/home/someone/.dsh"')], ['/home/someone/.dsh'])
  assert.deepEqual([...absoluteLiterals(PATCH)], ['/.npm-global/bin/clawmem'])
})

test('control: the loader dialect rejects the incident revision', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const broken = PATCH.replace(/^\s*command: .*$/m, INCIDENT_LINE)
  assert.notEqual(broken, PATCH, 'the control must actually change the file')
  assert.throws(
    () => parseWithLoader(broken),
    (error) => error && error.name === 'YAMLException' && /bad indentation of a mapping entry/.test(error.message),
    'the unquoted revision must fail exactly as the loader failed',
  )
})

test('control: a !!js value that is a mapping, not a scalar, cannot pass silently', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const mutant = PATCH.replace(/^\s*command: .*$/m, '        command: !!js a ? b : c')
  let problem = null
  try {
    const doc = parseWithLoader(mutant)
    const command = doc[0].insert[0].config.command
    if (typeof command.__jsExpr !== 'string') problem = 'command parsed to ' + JSON.stringify(command)
  } catch (error) { problem = 'parse: ' + error.message }
  assert.ok(problem, 'a non-scalar !!js value must be rejected either by the parse or by the type assertion')
  assert.match(problem, /parse: .*(mapping|expected)|command parsed to/, 'the reason must be the mapping, not an unrelated failure')
  assert.notEqual(yamlHazard('        command: !!js a ? b : c'), null, 'and the lint refuses an unquoted !!js value')
})

// ------------------------------------------------------- trailing comments (NEW-6)

test('control: a legal trailing YAML comment does not change the verdict', () => {
  const commented = PATCH.replace(/^(\s*command: .*)$/m, '$1 # pin the binary')
  assert.notEqual(commented, PATCH, 'the control must add the comment')
  assert.deepEqual(lintHazards(commented), [], 'a legal trailing comment must not be a hazard')
  assert.deepEqual([...absoluteLiterals(commented)], ['/.npm-global/bin/clawmem'], 'the literal must still be extracted')
  const line = commented.split('\n').find((candidate) => /command: !!js/.test(candidate))
  assert.equal(expressionText(line), EXPECTED_EXPRESSIONS[0], 'the expression text must survive the comment')
  // The stripper must not eat a '#' that sits inside a quoted literal.
  assert.equal(expressionText('        command: !!js "a # b"'), 'a # b')
  assert.equal(expressionText("        command: !!js 'a # b'"), 'a # b')
  // Delta LOW: a path written inside a trailing comment stays visible to the literal scanner.
  assert.deepEqual([...absoluteLiterals('        command: !!js "x" # "/opt/secret"')], ['/opt/secret'],
    'a path in a trailing comment must still be reported')
  // Re-audit finding 4: a FULL-LINE comment ships too, so a path there must be reported as well.
  assert.deepEqual([...absoluteLiterals('        # /opt/hidden')], ['/opt/hidden'],
    'a path in a full-line comment must be reported')
  // Real trailing content is still refused (no regression of the incident class).
  assert.notEqual(yamlHazard('        command: "a" : "b"'), null, 'a quoted value with trailing content is still a hazard')
  assert.match(yamlHazard('        command: "x" "a : b"') || '', /trailing content/)
})

test('control: the commented file parses to the same expressions', (t) => {
  if (!jsyaml) { t.skip('js-yaml is not resolvable from the DSH install'); return }
  const commented = PATCH.replace(/^(\s*command: .*)$/m, '$1 # pin the binary')
  assert.equal(expressionPinHolds(parseWithLoader(commented)), true, 'the parsed document must carry the same expressions')
})

test('control: YAML single-quote escaping is handled as YAML defines it (re-audit N2)', () => {
  // Inside single quotes a backslash is literal, so this value really is fatal: the quote closes after the
  // backslash and the remaining ' : ' is an unbounded separator. Reading the backslash as an escape (the old
  // behaviour) left the quote open and hid exactly this.
  assert.notEqual(yamlHazard("        command: a ' \\' b : c"), null, 'a line YAML rejects must not look safe')
  // Two consecutive quotes are an escaped quote, so a fully quoted scalar is legal and must stay clean.
  assert.equal(yamlHazard("        command: 'a '' b : c'"), null, 'an escaped quote must not be a false positive')
  // The scalar test must follow the same rule, or the hazard rule above cannot fire.
  assert.equal(isQuotedScalar("'a '' b : c'"), true, 'a single-quoted scalar may carry an escaped quote')
  assert.equal(isQuotedScalar("'a \\' b'"), false, 'a backslash is not an escape inside single quotes')
  assert.equal(isQuotedScalar("'a' 'b'"), false, 'two adjacent scalars are not one quoted scalar')
})

test('control: the separator rule is quote-aware and independent of the key charset (M4/M5)', () => {
  assert.equal(yamlHazard("        args: ['a: b']"), null, 'a space-colon inside a quoted flow item is content, not a separator')
  assert.equal(yamlHazard('        args: ["a: b"]'), null)
  assert.match(yamlHazard('        $schema: a : b') || '', /space-colon-space/, 'a key outside [A-Za-z0-9_.-] must still be checked')
  assert.match(yamlHazard('        a b: c : d') || '', /space-colon-space/)
  assert.equal(yamlHazard('        serverName: clawmem'), null, 'an ordinary scalar stays clean')
  assert.equal(yamlHazard("        args: ['mcp']"), null)
})

// ------------------------------------------------ F2: no silent loss of the structural layer

test('guard: the loader parser is resolvable, so the structural layer cannot skip silently', () => {
  if (process.env.DSH_CLAWMEM_ALLOW_NO_YAML === '1') return
  assert.ok(jsyaml, 'js-yaml is not resolvable, so every structural test would SKIP while the suite still exits 0; install js-yaml in the checkout, or set DSH_CLAWMEM_ALLOW_NO_YAML=1 to accept the degradation')
})
