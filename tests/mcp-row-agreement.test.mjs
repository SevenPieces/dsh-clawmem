// R4 #13 / R6 #24: the MCP client row's !!js command and lib/clawmem.js
// resolveClawmemBin() are two INDEPENDENT implementations of the same R-2 resolution
// rule, and nothing asserted that they agree. This test evaluates the shipped
// expression exactly as the loader does (new Function with process in scope) and
// compares it against the resolver for every environment the design distinguishes.
//
// Dependency-free on purpose: the expression is extracted with a regex, so this test
// still runs when no YAML parser is resolvable. tests/patch-yaml.test.mjs parses the
// same file properly when a parser is available.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveClawmemBin } from '../lib/clawmem.js'

const PATCH_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')
const PATCH = readFileSync(PATCH_PATH, 'utf8')

function commandExpressionFrom(text) {
  // Scope the search to the memory-clawmem ROW so a decoy 'command: !!js' line elsewhere in
  // the file cannot be read instead of the MCP row's own command, and REFUSE to guess when
  // the row carries more than one: an ambiguous row must fail loudly, not silently.
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*-\s*id:\s*['"]?memory-clawmem['"]?\s*$/.test(line))
  assert.ok(start >= 0, 'the patch must insert a memory-clawmem row')
  const rowIndent = (lines[start].match(/^\s*/) || [''])[0]
  const candidates = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (new RegExp('^' + rowIndent + '-\\s').test(lines[i])) break
    const match = /^\s*(?:"command"|command)\s*:\s*!!js\s+(.*)$/.exec(lines[i])
    if (match) candidates.push(match[1].trim())
  }
  assert.equal(candidates.length, 1, 'the row must carry exactly one !!js command line, got ' + candidates.length)
  let value = candidates[0]
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  if (quoted) value = value.slice(1, -1)
  return value
}

function commandExpression() {
  return commandExpressionFrom(PATCH)
}

/**
 * The contract a config expression must satisfy. `needsEnv` is true for the command, which
 * must derive its value from the environment; every expression must avoid the escape hatches.
 * The patterns deliberately accept YAML/JS spellings a substring check would miss (X2):
 * bracket notation, import(), eval().
 */
function expressionProblems(expression, needsEnv) {
  const problems = []
  const reads = (name) => new RegExp('process\\.env\\s*(?:\\.\\s*' + name + '|\\[\\s*[\'"]' + name + '[\'"]\\s*\\])').test(expression)
  if (needsEnv) {
    if (!reads('CLAWMEM_BIN')) problems.push('must read $CLAWMEM_BIN')
    if (!reads('HOME')) problems.push('must read $HOME')
  }
  if (reads('PATH')) problems.push('must not read PATH')
  if (/require/.test(expression)) problems.push('must not use require')
  if (/\bimport\s*\(/.test(expression)) problems.push('must not use import()')
  if (/\beval\s*\(/.test(expression)) problems.push('must not use eval()')
  return problems
}

const EXPRESSION = commandExpression()

/** Evaluate the shipped expression the way the loader does: with process in scope. */
function mcpCommandFor(env) {
  // The loader evaluates the expression with the real process object in scope, so the
  // injected stand-in must expose .env exactly as Node does.
  return new Function('process', 'return (' + EXPRESSION + ')')({ env: env })
}

/**
 * What the hook client would pick, with the filesystem modelled explicitly: only the
 * listed paths exist, so the PATH and $HOME/.npm-global steps are deterministic.
 */
function hookBinFor(env, existing) {
  return resolveClawmemBin({ configured: null, env, isExecutable: (candidate) => existing.indexOf(candidate) !== -1 }).bin
}

test('the shipped MCP expression reads only $CLAWMEM_BIN and $HOME - never PATH', () => {
  assert.match(EXPRESSION, /process\.env\.CLAWMEM_BIN/)
  assert.match(EXPRESSION, /process\.env\.HOME/)
  assert.deepEqual(expressionProblems(EXPRESSION, true), [], 'the row expression satisfies its contract')
})

test('MCP row and hook client agree wherever the design says they must', () => {
  const explicit = { CLAWMEM_BIN: '/opt/cm/clawmem', HOME: '/home/u', PATH: '/tools:/bin' }
  assert.equal(mcpCommandFor(explicit), '/opt/cm/clawmem')
  assert.equal(hookBinFor(explicit, []), '/opt/cm/clawmem', '$CLAWMEM_BIN wins in both')

  const npmGlobal = { HOME: '/home/u', PATH: '/bin' }
  assert.equal(mcpCommandFor(npmGlobal), '/home/u/.npm-global/bin/clawmem')
  assert.equal(hookBinFor(npmGlobal, ['/home/u/.npm-global/bin/clawmem']), '/home/u/.npm-global/bin/clawmem', 'the npm-global convention agrees')

  assert.equal(mcpCommandFor({}), 'clawmem')
  assert.equal(hookBinFor({}, []), 'clawmem', 'with nothing at all both fall back to the bare name')
})

test('control: the row reader ignores a decoy entry and refuses an ambiguous row', () => {
  const decoy = "- insert:\n    - id: decoy\n      name: x\n      config:\n        command: !!js \"/decoy/clawmem\"\n" + PATCH
  assert.equal(commandExpressionFrom(decoy), EXPRESSION, 'a command line outside the memory-clawmem row must be ignored')
  const ambiguous = PATCH.replace(/^(\s*)command: !!js /m, '$1command: !!js "decoy"\n$1command: !!js ')
  assert.notEqual(ambiguous, PATCH, 'the control must actually change the file')
  assert.throws(() => commandExpressionFrom(ambiguous), /exactly one !!js command line/, 'an ambiguous row must fail loudly')
})

test('control: the expression contract rejects every escape hatch, in any spelling', () => {
  assert.deepEqual(expressionProblems(EXPRESSION, true), [], 'the shipped expression satisfies the contract')
  assert.ok(expressionProblems('process.env.CLAWMEM_BIN || process.env.HOME + process.env.PATH', true).includes('must not read PATH'))
  assert.ok(expressionProblems("process.env.CLAWMEM_BIN + process.env['PATH']", true).includes('must not read PATH'), 'bracket notation counts too')
  assert.ok(expressionProblems('require("fs").existsSync(process.env.HOME)', true).includes('must not use require'))
  assert.ok(expressionProblems('import("fs") && process.env.HOME', true).includes('must not use import()'))
  assert.ok(expressionProblems('eval("process.env.HOME")', true).includes('must not use eval()'))
  assert.ok(expressionProblems('"clawmem"', true).includes('must read $CLAWMEM_BIN'))
  assert.deepEqual(expressionProblems('process.cwd()', false), [], 'a field that need not read the environment passes')
})

test('every config expression in the file satisfies the negative half of the contract', () => {
  const expressions = PATCH.split('\n').map((line) => /:\s*!!js\s+(.*)$/.exec(line)).filter(Boolean).map((match) => {
    let value = match[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return value
  })
  assert.ok(expressions.length >= 2, 'the file carries more than one expression: ' + JSON.stringify(expressions))
  for (const expression of expressions) {
    assert.deepEqual(expressionProblems(expression, false), [], 'expression: ' + expression)
  }
})

test('a padded or whitespace-only $CLAWMEM_BIN behaves the same in both implementations', () => {
  const padded = { CLAWMEM_BIN: '  /opt/cm/clawmem  ', HOME: '/home/u', PATH: '/bin' }
  assert.equal(mcpCommandFor(padded), '/opt/cm/clawmem', 'the row trims')
  assert.equal(hookBinFor(padded, []), '/opt/cm/clawmem', 'and so does the resolver')
  const blank = { CLAWMEM_BIN: '   ', HOME: '/home/u', PATH: '/bin' }
  assert.equal(mcpCommandFor(blank), '/home/u/.npm-global/bin/clawmem', 'a blank value falls through in the row')
  assert.equal(hookBinFor(blank, ['/home/u/.npm-global/bin/clawmem']), '/home/u/.npm-global/bin/clawmem')
})

test('the documented PATH asymmetry is real, and pinning $CLAWMEM_BIN removes it', () => {
  // A host whose clawmem is on PATH but NOT under $HOME/.npm-global: the hook client
  // finds it, the MCP row cannot - so the MCP server would fail to spawn while the
  // hooks work. This is the divergence R3/R4/R5/R6 all flagged; if a future change
  // makes them agree, this test says so and the README must be updated with it.
  const pathOnly = { HOME: '/home/u', PATH: '/tools:/bin' }
  const hookBin = hookBinFor(pathOnly, ['/tools/clawmem'])
  const mcpBin = mcpCommandFor(pathOnly)
  assert.equal(hookBin, '/tools/clawmem')
  assert.equal(mcpBin, '/home/u/.npm-global/bin/clawmem')
  assert.notEqual(hookBin, mcpBin, 'documented divergence: the MCP row does not search PATH')

  // Both exist: an older clawmem on PATH AND the npm-global one. The row takes the npm-global
  // path, the hook client takes PATH's - two different binaries in one session, exactly as the
  // README warns (X3 D1: the README claimed this case was covered; now it is).
  const both = { HOME: '/home/u', PATH: '/tools:/bin' }
  const bothHook = hookBinFor(both, ['/tools/clawmem', '/home/u/.npm-global/bin/clawmem'])
  assert.equal(mcpCommandFor(both), '/home/u/.npm-global/bin/clawmem')
  assert.equal(bothHook, '/tools/clawmem', 'the hook client prefers PATH')
  assert.notEqual(mcpCommandFor(both), bothHook, 'the both-exist hazard is real')

  const pinned = { CLAWMEM_BIN: '/tools/clawmem', HOME: '/home/u', PATH: '/tools:/bin' }
  assert.equal(mcpCommandFor(pinned), hookBinFor(pinned, ['/tools/clawmem']), 'pinning $CLAWMEM_BIN aligns them')
})

test('a config-set clawmemBin cannot reach the MCP row (documented limitation)', () => {
  const env = { HOME: '/home/u', PATH: '/bin' }
  const withConfig = resolveClawmemBin({ configured: '/custom/clawmem', env, isExecutable: () => false }).bin
  assert.equal(withConfig, '/custom/clawmem', 'the hook client honours the plugin config')
  assert.equal(mcpCommandFor(env), '/home/u/.npm-global/bin/clawmem', 'the MCP row only sees $CLAWMEM_BIN/$HOME')
})
