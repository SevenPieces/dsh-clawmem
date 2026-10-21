// Publication-surface guard (X3/E5; hardened in round 21 after X4's bypass report, in round 27
// after NEW-1..NEW-4, and in round 28 after the independent V-R27B and V-R27C audits).
//
// A real home path reached a git-tracked test in an earlier batch and survived several scans,
// because nothing inspected file CONTENT for machine identity. This guard closes that class, and it
// does so against the REAL publication surface rather than a hand-written model of it:
//   - every file the walk can reach is scanned, in its NAME and in its BYTES. The walk skips .git
//     as an entry of ANY type (in a linked worktree it is a pointer FILE; measured: the real npm
//     never packs it), every symlink (measured: npm packs neither a link to a file nor a link to a
//     directory), and the two exact private documents. It deliberately does NOT skip *.tgz, *.log
//     or node_modules: measured against npm 11, all three DO ship when they sit under an allowed
//     "files" entry (they used to be skipped - NEW-2);
//   - a second test asks npm itself ("npm pack --dry-run --json") for the real file list and requires
//     it to be a SUBSET of the scanned set, to be exactly the reviewed list, and to be free of
//     .tgz / .log / node_modules / a second YAML file, so the model cannot drift from the tool;
//   - content is decoded as UTF-8 AND UTF-16LE and JSON-escaped slashes are normalised, so those
//     three spellings cannot hide the path. Base64, gzip, hex, homoglyphs, a literal split across an
//     expression and the "~user" form remain out of scope for a text scan and are recorded as
//     accepted limits, not as checks;
//   - the hostname comparison is case-insensitive and word-bounded, and it is exercised directly so it
//     cannot become vacuous on a machine whose name has no letters; the rule has NO off switch, because
//     an earlier length-and-letter gate silently disabled it on short or numeric hostnames (delta MEDIUM).
//     Word-bounded is deliberately WEAKER than the plain substring search it replaced: a hostname glued into
//     a longer alphanumeric token is not reported (accepted - the home-path rule still covers this machine);
//   - the two private working documents are skipped as EXACT files, never as a subtree, so a
//     DIRECTORY that merely shares their name is still walked;
//   - the .gitignore rule is verified by running git in a throwaway repository (git check-ignore
//     plus git status --porcelain) with the developer's global git config neutralised, not by
//     pattern-matching the file: a "!" negation re-includes a file, and the old textual check passed
//     anyway (NEW-1);
//   - the heavy layers are PRECONDITIONED, not optional: without git, npm or a YAML parser the
//     strongest checks used to disappear while the suite still exited 0 (V-R27C H1/H2). Each now
//     fails loudly unless the operator accepts the loss through an explicit environment variable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The owner-only working documents: not in the npm allowlist and not in the repository. */
const NOT_DISTRIBUTED = new Set(['DECISIONS.md', 'clawmem_option_b_trigger_block.md'])
/**
 * The synthetic home names the fixtures below use. Every name listed here MUST be planted by a
 * fixture and no other name may be exempt: a whitelisted name that no fixture uses hides a real
 * leak (V-R27C M1 planted a foreign home path under an unused name and the guard stayed green).
 */
const SYNTHETIC_HOME = new Set(['u', 'someone', 'nobody'])
/**
 * VCS metadata is never packed, whatever its ENTRY TYPE: in a normal checkout .git is a directory,
 * in a linked worktree it is a FILE holding "gitdir: <absolute path>", and npm ships neither. Every
 * other real directory - including a nested node_modules, or one whose name ends in .tgz - is packed
 * when it sits under an allowed "files" entry, so the walk must descend into it.
 */
const NEVER_PACKED_NAMES = new Set(['.git'])
/**
 * Foreign home spellings, assembled at run time on purpose: a literal foreign home path in this
 * file would be a real hit and the guard would (correctly) flag itself.
 */
const FOREIGN = {
  linux: '/' + 'home' + '/' + 'user',
  mac: '/' + 'Users' + '/' + 'otherdev',
  win: 'C:' + '\\\\' + 'Users' + '\\\\' + 'otherdev',
}

/** A home directory in each of the three shapes the audits planted (V-R27C M2). */
const HOME_PATH = /(\/home\/|\/Users\/|[A-Za-z]:[\\/]+Users[\\/]+)([A-Za-z0-9._-]+)/gi
const YAML = /\.ya?ml$/i
const HOME = homedir()
const HOST = hostname()
const HOME_SEGMENTS = HOME.split('/').filter(Boolean)
/** The opposite case, so a fixture can exercise the case-insensitive rule on any hostname. */
const FLIPPED_HOST = HOST === HOST.toUpperCase() ? HOST.toLowerCase() : HOST.toUpperCase()
/** The developer's own git config must not decide the verdict (V-R27C L2: core.excludesFile). */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const GIT = spawnSync('git', ['--version'], { encoding: 'utf8', env: GIT_ENV })
const NPM = spawnSync('npm', ['--version'], { encoding: 'utf8' })

/** The reviewed publication surface - a new shipped file must be added here deliberately. */
const EXPECTED_PACK = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/clawmem.js',
  'lib/dsh-resolve.js',
  'lib/index.js',
  'lib/pressure.js',
  'lib/transcript.js',
  'package.json',
  'routing-block.dsh.md',
]

/**
 * A precondition a heavy layer depends on. Missing tooling fails the run unless the operator sets
 * the matching environment variable, in which case the loss is reported as a skip (V-R27C H1/H2).
 */
function requireTool(t, label, probe, optOut) {
  if (probe.status === 0) return true
  const detail = String(probe.error ? probe.error.message : probe.stderr || '').trim().slice(0, 200)
  if (process.env[optOut] === '1') {
    t.skip(label + ' is unavailable (' + detail + '); accepted because ' + optOut + '=1')
    return false
  }
  assert.fail(label + ' is unavailable (' + detail + '), so this publication check cannot run; install it, or set ' + optOut + '=1 to accept the gap')
}

/** Every file the publication walk reaches under "root", minus the two private documents. */
function shippedFiles(root, dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(root, full)
    // VCS metadata is skipped by NAME, whatever the entry type: a linked worktree stores .git as a
    // FILE whose bytes are "gitdir: <absolute home path>", so reading it would report the developer's
    // own identity (T-F4a). A nested .git entry is metadata too.
    if (NEVER_PACKED_NAMES.has(entry.name)) continue
    // npm packs no symlink at all (measured: neither a link to a file nor a link to a directory is in
    // npm pack --dry-run), so a link is not publication content. Do not descend into a linked
    // directory (its target can be anywhere) and do not read a link (a link to a directory is EISDIR).
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      // A real directory is ALWAYS walked: skipping by name would let a directory called scratch.tgz
      // (or one named after an ignored file) hide its whole subtree.
      shippedFiles(root, full, acc)
      continue
    }
    // Only regular files can be read, and only regular files are packed: a FIFO, socket or device is
    // never publication content, and reading one is not safe.
    if (!entry.isFile()) continue
    if (NOT_DISTRIBUTED.has(rel)) continue
    acc.push(full)
  }
  return acc
}

/** Every foreign home path in a fragment, ignoring the synthetic names the fixtures use. */
function foreignHomePaths(fragment) {
  const found = []
  if (typeof fragment !== 'string') return found
  HOME_PATH.lastIndex = 0
  let match
  while ((match = HOME_PATH.exec(fragment)) !== null) {
    // The exemption is deliberately shape-bound: the fixtures only ever use the POSIX /home/ form, so a
    // foreign /Users/<fixture-name> or drive-letter spelling is still reported (delta LOW).
    if (match[1].toLowerCase() !== '/home/' || !SYNTHETIC_HOME.has(match[2])) found.push(match[0])
  }
  HOME_PATH.lastIndex = 0
  return found
}

/**
 * The hostname is a required input everywhere it is used. A missing one used to fall through as "no match",
 * which is how a dropped argument silently switched the rule off (re-audit findings 1a/1b); now it throws.
 */
function requireHost(host, where) {
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error(where + ' requires the hostname; a missing host must not silently disable the rule')
  }
  return host
}

/**
 * Case-insensitive, word-bounded hostname containment. The boundary is what makes the rule usable on
 * every host: an earlier revision instead disabled it for short or numeric hostnames, which was a silent
 * switch-off in a batch whose whole purpose was to remove silent skips (delta MEDIUM). Bounding the match
 * keeps the rule active everywhere while refusing to fire on the hostname embedded in a longer token.
 */
function hostMatches(text, host) {
  const wanted = requireHost(host, 'hostMatches')
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(^|[^A-Za-z0-9])' + escaped + '([^A-Za-z0-9]|$)', 'i').test(text)
}

/**
 * Why this relative path is an identity leak, if it is. The host is a PARAMETER, never a module-level
 * gate: the previous revision could switch the hostname rule off for a short or numeric host *at the call
 * sites*, and a call-site gate is invisible to an assertion that only calls hostMatches() (delta F1).
 */
function pathOffenders(rel, host) {
  requireHost(host, 'pathOffenders')
  const reasons = []
  if (HOME && rel.includes(HOME)) reasons.push('the path carries the home directory')
  if (hostMatches(rel, host)) reasons.push('the path carries the hostname')
  for (const foreign of foreignHomePaths(rel)) reasons.push('the path carries ' + foreign)
  return reasons
}

/**
 * Every decoding a text scan must consider. UTF-16BE needs its own: Node has no 'utf16be', so the bytes are
 * swapped and read as LE (re-audit N1 - a BE-encoded path used to escape this scan entirely).
 */
function decodings(buffer) {
  const found = [buffer.toString('utf8'), buffer.toString('utf16le')]
  if (buffer.length % 2 === 0) found.push(Buffer.from(buffer).swap16().toString('utf16le'))
  return found
}

/** Why this file's bytes are an identity leak, if they are. The host is a parameter for the same reason. */
function contentOffenders(file, host) {
  requireHost(host, 'contentOffenders')
  const buffer = readFileSync(file)
  for (const raw of decodings(buffer)) {
    const text = raw.split('\\/').join('/')
    if (HOME && text.includes(HOME)) return ['the content carries the home directory']
    if (hostMatches(text, host)) return ['the content carries the hostname']
    const foreign = foreignHomePaths(text)
    if (foreign.length) return ['the content carries ' + foreign[0]]
  }
  return []
}

/**
 * The packed-name scan, factored out so a test can drive the SAME code path with a hostname-bearing entry.
 * An assertion that calls pathOffenders() directly cannot see a dropped argument at the call site - which is
 * exactly how the batch-5 regression hid (re-audit finding 1a).
 */
function packedNameOffenders(packed, host) {
  requireHost(host, 'packedNameOffenders')
  const named = []
  for (const path of packed) for (const reason of pathOffenders(path, host)) named.push(path + ': ' + reason)
  return named
}

/** Every identity leak in the publication walk from "root" - the guard's whole verdict. */
function identityOffenders(root, host) {
  requireHost(host, 'identityOffenders')
  const offenders = []
  for (const file of shippedFiles(root, root, [])) {
    const rel = relative(root, file)
    for (const reason of pathOffenders(rel, host)) offenders.push(rel + ': ' + reason)
    for (const reason of contentOffenders(file, host)) offenders.push(rel + ': ' + reason)
  }
  return offenders
}

/** A throwaway copy of the tree (no .git, no node_modules), planted with a fixture. */
function withLab(plant, host = HOST) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pub-lab-'))
  try {
    const lab = join(base, 'tree')
    cpSync(ROOT, lab, { recursive: true, filter: (src) => !['.git', 'node_modules'].includes(basename(src)) })
    plant(lab)
    return identityOffenders(lab, host)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

/** True when the manifest "files" allowlist covers this relative path. */
function allowlisted(files, rel) {
  return files.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry))
}

// ------------------------------------------------------------------ the shipped tree

test('no file the publication walk reaches carries this machine\'s identity - in its name or its bytes', () => {
  assert.deepEqual(identityOffenders(ROOT, HOST), [], 'machine identity in a reachable file')
})

// T-F4: the walk must model what npm actually packs. Two entry kinds it used to
// mishandle are exercised as controls, and the real-tree consequence is pinned:
//   (a) a linked worktree stores .git as a POINTER FILE ("gitdir: <home>/..."), not a
//       directory, so scanning it flags the developer's own home path;
//   (b) a symlink is neither a directory nor a readable regular file - npm does not
//       pack symlinks (verified: a symlink to a file and to a dir are both absent
//       from npm pack --dry-run), so it must be skipped, not read (EISDIR);
//   (c) the real scan of THIS worktree must therefore be clean.
// Skipping those entry kinds must not weaken the guard: a REGULAR file is still
// scanned, and (b) asserts that directly beside the link it ignores.

test('T-F4 (a): a .git pointer file in a linked worktree is not publication content', () => {
  let offenders
  assert.doesNotThrow(() => {
    offenders = withLab((lab) => writeFileSync(join(lab, '.git'), 'gitdir: ' + HOME + '/x' + String.fromCharCode(10)))
  }, 'the walk must not treat a .git pointer file as publication content')
  assert.deepEqual(offenders, [], 'the .git pointer file names the home directory but is never packed')
})

test('T-F4 (b): an untracked symlinked directory is neither walked nor reported', () => {
  const outside = mkdtempSync(join(tmpdir(), 'dsh-pub-symlink-'))
  try {
    // Identity inside the link's target is deliberately planted: npm does not pack the
    // symlink, so neither the link nor its target is part of the publication surface.
    writeFileSync(join(outside, 'leak.md'), 'const p = ' + JSON.stringify(HOME) + ';' + String.fromCharCode(10))
    let offenders
    assert.doesNotThrow(() => {
      offenders = withLab((lab) => {
        symlinkSync(outside, join(lab, 'linked-dir'), 'dir')
        // The guard must stay strong: a regular file planted beside the link is publication content
        // and must still be reported, while the symlink and its identity-bearing target are not.
        writeFileSync(join(lab, 'regular-leak.md'), 'const p = ' + JSON.stringify(HOME) + ';' + String.fromCharCode(10))
      })
    }, 'a symlinked directory must not crash the publication walk (EISDIR)')
    assert.deepEqual(offenders, ['regular-leak.md: the content carries the home directory'],
      'the regular neighbour is reported while the symlink and its identity-bearing target are not')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('T-F4 (c): the real ROOT scan is clean in this linked worktree', () => {
  // In a linked worktree .git is a 69-byte FILE whose content points at this
  // machine's gitdir; pre-fix the walk read it as a publication file and reported
  // the home directory inside it.
  assert.deepEqual(identityOffenders(ROOT, HOST), [], 'machine identity in a reachable file')
})

test('the hostname rule is case-insensitive, word-bounded and has no off switch', () => {
  // A synthetic pair, so the rule is exercised even on a host whose own name has no letters.
  const lower = 'examplehostname'
  const upper = 'EXAMPLEHOSTNAME'
  assert.equal(hostMatches('prefix-' + upper + '-suffix', lower), true)
  assert.equal(hostMatches('prefix-' + lower + '-suffix', upper), true)
  assert.equal(hostMatches('nothing here at all', lower), false)
  // And the real hostname still matches itself in either case.
  assert.equal(hostMatches('x-' + FLIPPED_HOST + '-y', HOST), true)
  // Delta MEDIUM: short and numeric hostnames must keep the rule ACTIVE rather than switch it off. The
  // names are assembled at run time so this file cannot collide with whatever the host is really called.
  const short = 'p' + 'i'
  const three = 'd' + 'e' + 'v'
  const numeric = '1' + '23456'
  assert.equal(hostMatches('x-' + short + '-y', short), true)
  assert.equal(hostMatches('x-' + three + '-y', three), true)
  assert.equal(hostMatches('x-' + numeric + '-y', numeric), true)
  // ... and the boundary still refuses the hostname embedded inside a longer token.
  assert.equal(hostMatches('x-' + numeric + '7-y', numeric), false)
  assert.equal(hostMatches('x' + short + 'ng-y', short), false)
})

test('control: the hostname rule is wired into the call sites for every host shape (delta F1)', () => {
  // The pre-batch revision could switch the hostname rule off for a short or numeric host AT THE CALL
  // SITES. Asserting hostMatches() alone cannot see that - a call-site gate is invisible to it - so this
  // control drives the real wiring with an injected host. Returning any length or letter gate to
  // pathOffenders/contentOffenders makes the offender disappear and fails here.
  for (const injected of ['p' + 'i', 'd' + 'e' + 'v', '1' + '23456']) {
    const inName = withLab((lab) => writeFileSync(join(lab, 'lib', 'note-' + injected + '.md'), 'plain\n'), injected)
    assert.ok(inName.includes('lib/note-' + injected + '.md: the path carries the hostname'),
      'a planted name must be reported for host ' + injected + ', got ' + JSON.stringify(inName))
    const inBody = withLab((lab) => writeFileSync(join(lab, 'lib', 'body-' + injected + '.js'), 'const h = "' + injected + '";\n'), injected)
    assert.ok(inBody.includes('lib/body-' + injected + '.js: the content carries the hostname'),
      'a planted body must be reported for host ' + injected + ', got ' + JSON.stringify(inBody))
  }
  // And the regression SHAPE must not exist anywhere in this file, whatever it is called. The patterns are
  // assembled from pieces and properly escaped so they neither match their own text nor lose their regex
  // meaning - an earlier version collapsed its escapes inside a string literal and matched nothing useful.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const backslash = String.fromCharCode(92)
  const hostWord = 'h' + 'ost'
  const hostConst = 'H' + 'OST'
  const lengthWord = 'len' + 'gth'
  for (const name of [hostWord, hostConst]) {
    // name + an ESCAPED dot + the size word: the escapes cannot collapse, and the pieces mean this check
    // cannot match its own text (an earlier version matched its own failure message).
    assert.equal(new RegExp(name + backslash + '.' + lengthWord).test(source), false,
      'the hostname rule must not be gated by a size test')
    assert.equal(source.includes('test(' + name), false,
      'the hostname rule must not be gated by a character-class check')
  }
})

test('control: a missing host fails loudly instead of disabling the rule (re-audit 1a/1b)', () => {
  const self = fileURLToPath(import.meta.url)
  for (const [label, call] of [
    ['hostMatches', () => hostMatches('x', undefined)],
    ['hostMatches (whitespace)', () => hostMatches('x', ' ')],
    ['pathOffenders', () => pathOffenders('x', undefined)],
    ['contentOffenders', () => contentOffenders(self, undefined)],
    ['identityOffenders', () => identityOffenders(ROOT, undefined)],
    ['packedNameOffenders', () => packedNameOffenders(['x'], undefined)],
  ]) {
    assert.throws(call, /requires the hostname/, label + ' must throw when the host is missing')
  }
})

test('the foreign-home rule sees every shape and exempts only planted fixtures', () => {
  assert.deepEqual(foreignHomePaths('/home/u /home/someone /home/nobody'), [], 'the fixtures must stay exempt')
  assert.deepEqual(foreignHomePaths(FOREIGN.linux), [FOREIGN.linux], 'V-R27C M1: a whitelisted-but-unused name hid this')
  assert.deepEqual(foreignHomePaths(FOREIGN.mac), [FOREIGN.mac], 'V-R27C M2: the macOS shape')
  assert.deepEqual(foreignHomePaths(FOREIGN.win), [FOREIGN.win], 'the Windows shape')
  assert.deepEqual(foreignHomePaths('/opt/local'), [], 'an ordinary path is not a home path')
  assert.deepEqual(foreignHomePaths(undefined), [], 'a non-string fragment is a documented no-op, not a throw')
  // Re-audit finding 3: the list must be exactly the planted names - an unused whitelisted name would exempt
  // a real leak of that name (the V-R27C M1 defect). Pinned here, and each name is planted and exempt.
  assert.deepEqual([...SYNTHETIC_HOME].sort(), ['nobody', 'someone', 'u'], 'the exemption list is reviewed')
  for (const name of SYNTHETIC_HOME) {
    const planted = '/' + 'home' + '/' + name
    assert.deepEqual(foreignHomePaths(planted + '/x'), [], 'the planted fixture ' + planted + ' must stay exempt')
  }
  // Delta LOW: the exemption is shape-bound, and the shape match is case-insensitive.
  const macFixtureName = '/' + 'Users' + '/' + 'u'
  assert.deepEqual(foreignHomePaths(macFixtureName), [macFixtureName], 'a /Users/<fixture-name> spelling is NOT exempt')
  const winFixtureName = 'C:' + '\\' + 'Users' + '\\' + 'u'
  assert.deepEqual(foreignHomePaths(winFixtureName), [winFixtureName], 'a drive-letter spelling of a planted name is NOT exempt')
  const lowerShape = '/' + 'users' + '/' + 'zzz'
  assert.deepEqual(foreignHomePaths(lowerShape), [lowerShape], 'a differently cased /Users/ prefix is still reported')
  const upperShape = '/' + 'HOME' + '/' + 'zzz'
  assert.deepEqual(foreignHomePaths(upperShape), [upperShape], 'a differently cased /home/ prefix is still reported')
})

test('control: the identity guard catches every vector the audits reported', () => {
  const escapedHome = HOME.split('/').join('\\/')
  const VECTORS = [
    ['a directory that spells the home path', (lab) => {
      const dir = join(lab, 'lib', ...HOME_SEGMENTS)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'note.md'), 'plain\n')
    }],
    ['the hostname in a file NAME', (lab) => {
      writeFileSync(join(lab, 'lib', 'note-' + HOST + '.md'), 'plain\n')
    }],
    ['a DIRECTORY named like a private document (exact file, never a subtree)', (lab) => {
      const dir = join(lab, 'lib', 'DECISIONS.md')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'leak.md'), 'const p = "' + HOME + '";\n')
    }],
    ['a UTF-16BE encoded home path (re-audit N1)', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-utf16be.js'), Buffer.from('const p = "' + HOME + '";', 'utf16le').swap16())
    }],
    ['a drive-letter home path', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-win.js'), 'const p = ' + JSON.stringify(FOREIGN.win) + ';\n')
    }],
    ['a JSON-escaped slash spelling of the home path (X4 B2)', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-json-escaped.js'), 'const p = "' + escapedHome + '";\n')
    }],
    ['UTF-16LE bytes (X4 B3)', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-utf16le.js'), Buffer.from('const p = "' + HOME + '";', 'utf16le'))
    }],
    ['the hostname in the other case (X4 B5)', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-case.js'), 'const h = "' + FLIPPED_HOST + '";\n')
    }],
    ['a FOREIGN home path whose name looks synthetic (V-R27C M1)', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-user.js'), 'const p = "' + FOREIGN.linux + '/private/notes";\n')
    }],
    ['a macOS /Users home path (V-R27C M2)', (lab) => {
      writeFileSync(join(lab, 'lib', 'leak-macos.js'), 'const p = "' + FOREIGN.mac + '/secret";\n')
    }],
    ['a DIRECTORY whose name looks like an ignored suffix (X4 B8)', (lab) => {
      const dir = join(lab, 'lib', 'scratch.tgz')
      mkdirSync(dir)
      writeFileSync(join(dir, 'note.md'), 'const p = "' + HOME + '";\n')
    }],
    ['a leak inside node_modules, which npm ships under an allowed files entry (NEW-2)', (lab) => {
      const dir = join(lab, 'lib', 'node_modules', 'dep')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.js'), 'const p = "' + HOME + '";\n')
    }],
    ['a .log file, which npm ships under an allowed files entry (NEW-2)', (lab) => {
      writeFileSync(join(lab, 'lib', 'notes.log'), 'const p = "' + HOME + '";\n')
    }],
    ['a .tgz file, which npm ships under an allowed files entry (NEW-2)', (lab) => {
      writeFileSync(join(lab, 'lib', 'scratch.tgz'), 'const p = "' + HOME + '";\n')
    }],
  ]
  const escaped = []
  for (const [name, plant] of VECTORS) {
    if (withLab(plant).length === 0) escaped.push(name)
  }
  assert.deepEqual(escaped, [], 'these identity vectors passed the guard: ' + JSON.stringify(escaped))
  assert.equal(VECTORS.length, 14, 'the control set is reviewed: a removed or added vector must be deliberate')
})

// ------------------------------------------------------------------ the real git verdict

/** Run a real git repository at "root" and report how it treats "name". */
function gitVerdict(root, name) {
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env: GIT_ENV })
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', name], { cwd: root, env: GIT_ENV })
  const status = spawnSync('git', ['status', '--porcelain', '--', name], { cwd: root, encoding: 'utf8', env: GIT_ENV })
  return { ignored: ignored.status === 0, listed: status.stdout.trim() !== '' }
}

/** A throwaway repository carrying one .gitignore and the two private files. */
function withGitLab(gitignore) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-git-lab-'))
  try {
    const lab = join(base, 'tree')
    mkdirSync(lab)
    writeFileSync(join(lab, '.gitignore'), gitignore)
    const verdicts = new Map()
    for (const name of NOT_DISTRIBUTED) {
      writeFileSync(join(lab, name), 'private placeholder\n')
      verdicts.set(name, gitVerdict(lab, name))
    }
    return verdicts
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const SHIPPED_GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8')

test('a REAL git repository ignores both private working documents', (t) => {
  if (!requireTool(t, 'git', GIT, 'DSH_CLAWMEM_ALLOW_NO_GIT')) return
  for (const [name, verdict] of withGitLab(SHIPPED_GITIGNORE)) {
    assert.equal(verdict.ignored, true, name + ' must be ignored by real git (git check-ignore exit 0)')
    assert.equal(verdict.listed, false, name + ' must not appear in git status --porcelain')
  }
})

test('control: a "!" negation re-includes the file, and git - not a text filter - sees it (NEW-1)', (t) => {
  if (!requireTool(t, 'git', GIT, 'DSH_CLAWMEM_ALLOW_NO_GIT')) return
  const verdicts = withGitLab(SHIPPED_GITIGNORE + '\n!DECISIONS.md\n')
  assert.equal(verdicts.get('DECISIONS.md').ignored, false, 'a negation must defeat the ignore rule, and the guard must notice')
  assert.equal(verdicts.get('DECISIONS.md').listed, true, 'git must list the re-included file as untracked')
  assert.equal(verdicts.get('clawmem_option_b_trigger_block.md').ignored, true, 'the untouched rule still holds')
})

test('control: a comment-only .gitignore is not a rule (X4 B10)', (t) => {
  if (!requireTool(t, 'git', GIT, 'DSH_CLAWMEM_ALLOW_NO_GIT')) return
  const comments = [...NOT_DISTRIBUTED].map((name) => '# ' + name + '\n').join('')
  for (const [name, verdict] of withGitLab(comments)) {
    assert.equal(verdict.ignored, false, name + ' must NOT be ignored by a comment-only file')
  }
})

test('control: the developer\'s global git config cannot change the verdict (V-R27C L2)', (t) => {
  if (!requireTool(t, 'git', GIT, 'DSH_CLAWMEM_ALLOW_NO_GIT')) return
  // A global core.excludesFile naming the private document would make the comment-only fixture
  // "ignored" and flip the control above. GIT_ENV pins that config away, so the fixture below must
  // behave exactly like the same fixture elsewhere.
  const verdicts = withGitLab('# nothing here\n')
  for (const [name, verdict] of verdicts) {
    assert.equal(verdict.ignored, false, name + ' must stay unignored under an isolated git config')
  }
})

// ------------------------------------------------------------------ the manifest

test('the manifest ships the reviewed surface and keeps the private documents out', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.files, ['lib/', 'routing-block.dsh.md', 'cordis.patch.yml', 'README.md'])
  for (const name of NOT_DISTRIBUTED) {
    assert.equal(manifest.files.some((entry) => entry.includes(name)), false, name + ' must stay out of the package allowlist')
  }
  // NEW-3: the bundle patch is pinned, so the expression pin cannot be pointed at another file.
  assert.equal(manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch, './cordis.patch.yml',
    'the bundle patch must be the file the YAML guard examines')
  // NEW-4: the guard must actually run before a publish.
  assert.equal(typeof (manifest.scripts || {}).prepublishOnly, 'string', 'prepublishOnly must exist or npm publish skips the guard')
  assert.match(manifest.scripts.prepublishOnly, /node --test tests/,
    'prepublishOnly must run the very suite that carries the guard, got: ' + JSON.stringify(manifest.scripts.prepublishOnly))
  // Exactly one YAML file may SHIP: a decoy under lib/ would evade the expression pin. The check is
  // restricted to the allowlist, so an unpacked tests/ fixture is not a false alarm (V-R27C L1).
  const manifestYaml = shippedFiles(ROOT, ROOT, []).map((file) => relative(ROOT, file))
    .filter((rel) => YAML.test(rel) && allowlisted(manifest.files, rel))
  assert.deepEqual(manifestYaml, ['cordis.patch.yml'], 'a second shipped YAML file would evade the expression pin')
})

// ------------------------------------------------------------------ the real npm list

test('npm itself packs exactly the reviewed surface, with nothing extra', (t) => {
  if (!requireTool(t, 'npm', NPM, 'DSH_CLAWMEM_ALLOW_NO_NPM')) return
  const base = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  try {
    const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--cache', join(base, 'cache')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
    })
    assert.equal(run.status, 0, 'npm pack --dry-run failed: ' + String(run.stderr || run.error).trim().slice(0, 300))
    let report
    try { report = JSON.parse(run.stdout) } catch (error) {
      assert.fail('npm pack --json did not print JSON (' + error.message + '): ' + run.stdout.slice(0, 300))
    }
    const packed = report[0].files.map((file) => file.path).sort()
    // Every packed path must be inside the scanned set, or the scan under-reports (NEW-2).
    const scanned = new Set(shippedFiles(ROOT, ROOT, []).map((file) => relative(ROOT, file)))
    const unscanned = packed.filter((path) => !scanned.has(path))
    assert.deepEqual(unscanned, [], 'npm ships files the identity scan never looked at')
    assert.deepEqual(packed, EXPECTED_PACK, 'the published file list is reviewed: a change here must be deliberate')
    // Hygiene on the real list: the classes that used to be skipped by name.
    assert.deepEqual(packed.filter((path) => /\.(tgz|log)$/i.test(path)), [], 'no archive or log may ship')
    assert.deepEqual(packed.filter((path) => path.split('/').includes('node_modules')), [], 'no dependency tree may ship')
    assert.deepEqual(packed.filter((path) => YAML.test(path)), ['cordis.patch.yml'], 'exactly the reviewed patch file')
    assert.deepEqual(packedNameOffenders(packed, HOST), [], 'a packed NAME carries machine identity')
    // Re-audit finding 1a: drive the SAME scan with a hostname-bearing entry, so dropping the host at that
    // call site (the batch-5 bug) fails here instead of passing silently.
    assert.ok(packedNameOffenders(['lib/note-' + HOST + '.md'], HOST).length > 0,
      'the packed-name scan must see a hostname when one is present')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
