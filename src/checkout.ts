import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'

import { DevEnvError } from './errors.ts'

const run = promisify(execFile)

/*
 * A test environment has a lane, so test files can run side by side, each lane
 * with its own ports, containers and data. Lane 1 is plain `test`.
 */
export type Mode = 'dev' | 'test' | `test-${number}`

export const isTestMode = (mode: Mode): boolean => mode !== 'dev'

export const testModeOf = (lane: number): Mode =>
  lane === 1 ? 'test' : `test-${lane}`

export interface Checkout {
  readonly root: string
  readonly id: string
  readonly gitCommonDirectory: string
}

export const environmentIdOf = (root: string): string =>
  createHash('sha256').update(root).digest('hex').slice(0, 8)

export const environmentKeyOf = (target: string, mode: Mode): string =>
  mode === 'dev' ? target : `${target}.${mode}`

export const composeProjectOf = (
  checkout: Pick<Checkout, 'root' | 'id'>,
  target: string,
  mode: Mode
): string => {
  const name = basename(checkout.root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
  const suffix = mode === 'dev' ? '' : `-${mode}`

  return `${name || 'checkout'}-${checkout.id}-${target}${suffix}`
}

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

export const resolveCheckout = async (cwd: string): Promise<Checkout> => {
  try {
    const root = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'))
    const gitCommonDirectory = await git(
      cwd,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    )

    return { root, id: environmentIdOf(root), gitCommonDirectory }
  } catch {
    throw new DevEnvError(`${cwd} is not inside a git checkout.`)
  }
}

export const checkoutRootsOf = async (
  checkout: Checkout
): Promise<readonly string[]> => {
  const listing = await git(checkout.root, 'worktree', 'list', '--porcelain')

  return listing
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}
