import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function dshProfilesAnchor() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', 'noop.js')
}

export async function resolveDshModule(specifier) {
  const require = createRequire(dshProfilesAnchor())
  const resolved = require.resolve(specifier)
  return import(pathToFileURL(resolved).href)
}
