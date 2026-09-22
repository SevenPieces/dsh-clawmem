// tests/inject.test.mjs
// H1: the routing block must register through ctx.systemPrompt -> requires inject.
// H3: the registered clawmem skill must carry a string source or DSH cannot load it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject } from '../lib/index.js'

const LF = String.fromCharCode(10)
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')

/** Service names the real Cordis proxy resolves only when they are injected. */
const SERVICE_NAMES = new Set(['systemPrompt', 'skills', 'sessionProjections', 'jobs', 'loader'])

/** DSH validates a loaded runtime skill with validateDefinition (skill/src/index.ts:749-769). */
function validateLikeDsh(skill) {
  if (typeof skill.name !== 'string') throw new TypeError('loaded skill name must be a string')
  if (typeof skill.description !== 'string' || skill.description.length === 0) throw new Error('skill "' + String(skill.name) + '" requires a description')
  if (typeof skill.content !== 'string') throw new TypeError('loaded skill "' + String(skill.name) + '" content must be a string')
  if (typeof skill.source !== 'string') throw new TypeError('loaded skill "' + String(skill.name) + '" source must be a string')
}

/**
 * A Cordis-faithful fake ctx: every service granted by the plugin's OWN
 * exported inject array resolves; any other service access throws exactly the
 * error vendor/cordis/src/reflect.ts:144 raises.
 */
function makeCordisCtx(injectList, overrides) {
  const extra = overrides || {}
  const registered = { skills: [], sections: [] }
  const logs = []
  const handlers = new Map()
  const services = {
    systemPrompt: { section: (section) => { registered.sections.push(section); return () => {} } },
    skills: { register: (skill) => { validateLikeDsh(skill); registered.skills.push(skill); return () => {} }, registerProvider: () => {} },
    sessionProjections: { stateOf: () => undefined, snapshot: () => ({ asOfSeq: 0, values: {} }) },
    jobs: undefined,
    loader: undefined,
    ...extra,
  }
  const target = {
    logger: {
      info: (m) => logs.push({ level: 'info', message: String(m) }),
      warn: (m) => logs.push({ level: 'warn', message: String(m) }),
      error: (m) => logs.push({ level: 'error', message: String(m) }),
      debug: (m) => logs.push({ level: 'debug', message: String(m) }),
    },
    on(event, fn) {
      const list = handlers.get(event) || []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    get(serviceName) { return services[serviceName] },
    effect(execute) { const disposer = execute(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  for (const serviceName of Object.keys(services)) {
    if (injectList.includes(serviceName)) target[serviceName] = services[serviceName]
  }
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop)
      if (Reflect.has(t, prop)) return Reflect.get(t, prop)
      if (SERVICE_NAMES.has(prop)) throw new Error('cannot get property "' + prop + '" without inject')
      return undefined
    },
  })
  return { ctx, registered, logs, handlers }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-inject-'))
  const pkg = join(root, 'pkg')
  const binDir = join(pkg, 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'fake-clawmem.mjs')
  writeFileSync(bin, '#!/usr/bin/env node' + LF + 'process.stdout.write(JSON.stringify({ continue: true }))' + LF)
  chmodSync(bin, 0o755)
  writeFileSync(join(pkg, 'SKILL.md'), '---' + LF + 'name: clawmem' + LF + 'description: "ClawMem ops"' + LF + '---' + LF + 'body' + LF)
  return { root, bin }
}

test('inject declares systemPrompt so the routing seam is reachable', () => {
  assert.ok(Array.isArray(inject), 'inject is an array')
  assert.ok(inject.includes('systemPrompt'), 'inject must include systemPrompt')
  assert.ok(inject.includes('skills'), 'inject must keep skills')
  assert.ok(inject.includes('sessionProjections'), 'inject must keep sessionProjections')
})

test('apply registers exactly one clawmem:routing section whose text is routing-block.dsh.md', () => {
  const env = setup()
  const { ctx, registered, logs } = makeCordisCtx(inject, undefined)
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  assert.equal(registered.sections.length, 1, 'exactly one section')
  assert.equal(registered.sections[0].name, 'clawmem:routing')
  assert.equal(registered.sections[0].text, readFileSync(join(PLUGIN_DIR, 'routing-block.dsh.md'), 'utf8'))
  assert.ok(registered.sections[0].text.includes('mcp__clawmem__'), 'DSH-adapted tool names present')
  assert.deepEqual(logs.filter((entry) => entry.level === 'warn'), [], 'no warn is emitted on a healthy activation')
  rmSync(env.root, { recursive: true, force: true })
})

test('the registered clawmem skill survives DSH load-time validation (source is a string)', () => {
  const env = setup()
  const { ctx, registered } = makeCordisCtx(inject, undefined)
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  assert.equal(registered.skills.length, 1)
  const skill = registered.skills[0]
  assert.equal(skill.name, 'clawmem')
  assert.equal(typeof skill.source, 'string')
  assert.ok(skill.source.length > 0, 'source must be a non-empty string')
  assert.equal(typeof skill.content, 'string')
  assert.ok(skill.content.length > 0)
  assert.equal(skill.resourceBase.kind, 'directory')
  rmSync(env.root, { recursive: true, force: true })
})

test('as-deployed inject without systemPrompt leaves the section unregistered (H1 repro)', () => {
  const env = setup()
  const { ctx, registered } = makeCordisCtx(['skills', 'sessionProjections'], undefined)
  apply(ctx, { clawmemBin: env.bin, transcript: { dir: env.root, rotation: { enabled: false } } })
  assert.equal(registered.sections.length, 0, 'without systemPrompt the section cannot register')
  rmSync(env.root, { recursive: true, force: true })
})

test('routingBlock.mode off registers nothing and warns nothing', () => {
  const env = setup()
  const { ctx, registered, logs } = makeCordisCtx(inject, undefined)
  apply(ctx, { clawmemBin: env.bin, routingBlock: { mode: 'off' }, transcript: { dir: env.root, rotation: { enabled: false } } })
  assert.equal(registered.sections.length, 0)
  assert.deepEqual(logs.filter((entry) => entry.level === 'warn'), [])
  rmSync(env.root, { recursive: true, force: true })
})
