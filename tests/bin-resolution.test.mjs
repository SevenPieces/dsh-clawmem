// R-2: the shipped default must contain no machine-specific path. The clawmem
// binary is resolved once at startup, first hit wins:
//   explicit config -> $CLAWMEM_BIN -> `clawmem` on PATH -> $HOME/.npm-global/bin/clawmem
// falling back to the bare name so a system PATH can still serve it.
// Every input is injectable (env / home / pathValue / isExecutable) so the chain
// is unit-testable without touching the real filesystem.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveClawmemBin, createClawmemClient } from '../lib/clawmem.js'

const exec = (paths) => (candidate) => paths.includes(candidate)

test('R-2: an explicit configured path wins over env and PATH', () => {
  const got = resolveClawmemBin({
    configured: '/opt/custom/clawmem',
    env: { CLAWMEM_BIN: '/env/clawmem', PATH: '/usr/bin', HOME: '/home/someone' },
    isExecutable: exec(['/usr/bin/clawmem', '/env/clawmem']),
  })
  assert.deepEqual(got, { bin: '/opt/custom/clawmem', source: 'config' })
})

test('R-2: $CLAWMEM_BIN is used when no explicit config is set', () => {
  const got = resolveClawmemBin({
    env: { CLAWMEM_BIN: '/env/clawmem', PATH: '/usr/bin', HOME: '/home/someone' },
    isExecutable: exec(['/usr/bin/clawmem']),
  })
  assert.deepEqual(got, { bin: '/env/clawmem', source: 'env' })
})

test('R-2: a clawmem executable on PATH is used when config and env are empty', () => {
  const got = resolveClawmemBin({
    env: { PATH: '/first:/second:/usr/bin', HOME: '/home/someone' },
    isExecutable: exec(['/second/clawmem']),
  })
  assert.deepEqual(got, { bin: '/second/clawmem', source: 'path' })
})

test('R-2: empty PATH segments are skipped and non-executable candidates ignored', () => {
  const got = resolveClawmemBin({
    env: { PATH: ':/nope::/yes', HOME: '/home/someone' },
    isExecutable: exec(['/yes/clawmem']),
  })
  assert.equal(got.source, 'path')
  assert.equal(got.bin, '/yes/clawmem')
})

test('R-2: $HOME/.npm-global/bin/clawmem is the last resort before the bare name', () => {
  const got = resolveClawmemBin({
    env: { PATH: '/usr/bin', HOME: '/home/someone' },
    isExecutable: exec(['/home/someone/.npm-global/bin/clawmem']),
  })
  assert.deepEqual(got, { bin: '/home/someone/.npm-global/bin/clawmem', source: 'home-npm-global' })
})

test('R-2: with nothing found the bare name is kept so a system PATH can still serve it', () => {
  const got = resolveClawmemBin({
    env: { PATH: '/usr/bin', HOME: '/home/someone' },
    isExecutable: () => false,
  })
  assert.deepEqual(got, { bin: 'clawmem', source: 'name' })
})

test('R-2: with nothing found the result is the bare name, never a machine path', () => {
  const got = resolveClawmemBin({ env: { PATH: '/usr/bin:/bin', HOME: '/home/nobody' }, isExecutable: () => false })
  assert.equal(got.bin, 'clawmem')
  assert.equal(got.bin.startsWith('/'), false, 'no absolute machine path is ever baked in')
})

test('R-2: an unusable configured value (empty/null) falls through to the chain', () => {
  const viaEnv = resolveClawmemBin({ configured: null, env: { CLAWMEM_BIN: '/env/clawmem' }, isExecutable: () => false })
  assert.equal(viaEnv.source, 'env')
  const viaEmpty = resolveClawmemBin({ configured: '', env: { CLAWMEM_BIN: '' }, isExecutable: () => false })
  assert.equal(viaEmpty.bin, 'clawmem')
})

test('R-2: the hook client resolves the chain and exposes what it chose', () => {
  const client = createClawmemClient({
    bin: null,
    env: { PATH: '/tools', HOME: '/home/someone' },
    isExecutable: exec(['/tools/clawmem']),
  })
  assert.equal(typeof client.runHook, 'function')
  assert.equal(client.bin, '/tools/clawmem')
  assert.equal(client.binSource, 'path')
})

test('R-2: an explicit client bin still wins and is reported as configured', () => {
  const client = createClawmemClient({ bin: '/explicit/clawmem', env: { CLAWMEM_BIN: '/env/clawmem' }, isExecutable: exec(['/env/clawmem']) })
  assert.equal(client.bin, '/explicit/clawmem')
  assert.equal(client.binSource, 'config')
})

// R3 #8 / R6 #3: accessSync(X_OK) succeeds on a DIRECTORY, so a directory named
// clawmem earlier on PATH beat a real executable later on PATH - and every hook
// then failed with EACCES. The default isExecutable must require a regular file.
test('R-2: a DIRECTORY named clawmem on PATH is not accepted as the binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-dirbin-'))
  try {
    mkdirSync(join(root, 'first', 'clawmem'), { recursive: true })
    mkdirSync(join(root, 'second'), { recursive: true })
    writeFileSync(join(root, 'second', 'clawmem'), '#!/bin/sh' + String.fromCharCode(10) + 'exit 0' + String.fromCharCode(10))
    chmodSync(join(root, 'second', 'clawmem'), 0o755)
    const got = resolveClawmemBin({ env: { PATH: join(root, 'first') + ':' + join(root, 'second'), HOME: '' } })
    assert.equal(got.bin, join(root, 'second', 'clawmem'), 'the real executable must win over a directory')
    assert.equal(got.source, 'path')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R-2: a directory at the npm-global location is not accepted either', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-dirhome-'))
  try {
    mkdirSync(join(root, '.npm-global', 'bin', 'clawmem'), { recursive: true })
    const got = resolveClawmemBin({ env: { PATH: '', HOME: root } })
    assert.deepEqual(got, { bin: 'clawmem', source: 'name' }, 'a directory is not a binary, so the bare name is kept')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// R6 #4: the guard was only a truthy trim check, so a padded value was returned
// raw and the spawn then failed with ENOENT.
test('R-2: a relative or dot PATH segment still yields an absolute candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawmem-relpath-'))
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'clawmem'), '#!/bin/sh' + String.fromCharCode(10) + 'exit 0')
    chmodSync(join(root, 'clawmem'), 0o755)
    process.chdir(root)
    const got = resolveClawmemBin({ env: { PATH: '.', HOME: '' } })
    assert.equal(got.source, 'path', 'the executable in cwd is found')
    assert.equal(got.bin, join(root, 'clawmem'), 'and reported as an absolute path')
    assert.ok(isAbsolute(got.bin))
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }) }
})

test('R-2: a whitespace-padded configured or env value is trimmed', () => {
  assert.deepEqual(resolveClawmemBin({ configured: '  /x/clawmem  ' }), { bin: '/x/clawmem', source: 'config' })
  assert.deepEqual(resolveClawmemBin({ env: { CLAWMEM_BIN: String.fromCharCode(9) + '/y/clawmem ' } }), { bin: '/y/clawmem', source: 'env' })
})
