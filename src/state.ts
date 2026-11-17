import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { Mode } from './checkout.ts'
import { environmentIdOf, environmentKeyOf } from './checkout.ts'

export interface RecordedProcess {
  readonly pid: number
  readonly startedAt: string
  readonly logPath: string
}

export interface EnvironmentState {
  readonly environmentId: string
  readonly target: string
  readonly mode: Mode
  readonly ports: Readonly<Record<string, number>>
  readonly processes: Readonly<Record<string, RecordedProcess>>
  /** What the test that started it asked for, so a process it restarts runs with the same; absent for a dev environment. */
  readonly settings?: Readonly<Record<string, string>>
}

export const environmentDirectoryOf = (
  root: string,
  target: string,
  mode: Mode
): string => join(root, '.dev-env', environmentKeyOf(target, mode))

const statePathOf = (root: string, target: string, mode: Mode): string =>
  join(environmentDirectoryOf(root, target, mode), 'state.json')

const parseState = (
  path: string,
  root: string
): EnvironmentState | undefined => {
  if (!existsSync(path)) return undefined
  const state = JSON.parse(readFileSync(path, 'utf8')) as EnvironmentState

  // A checkout that was moved or copied carries ports and pids it never owned.
  return state.environmentId === environmentIdOf(root) ? state : undefined
}

export const readState = (
  root: string,
  target: string,
  mode: Mode
): EnvironmentState | undefined =>
  parseState(statePathOf(root, target, mode), root)

export const writeState = (root: string, state: EnvironmentState): void => {
  const path = statePathOf(root, state.target, state.mode)
  mkdirSync(environmentDirectoryOf(root, state.target, state.mode), {
    recursive: true,
  })
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2))
  renameSync(`${path}.tmp`, path)
}

export const dataDirectoryOf = (
  root: string,
  target: string,
  mode: Mode
): string => join(environmentDirectoryOf(root, target, mode), 'data')

/* Gives up the environment's ports and its processes' data. Logs stay, to explain a run that just failed. */
export const removeState = (root: string, target: string, mode: Mode): void => {
  rmSync(dataDirectoryOf(root, target, mode), { recursive: true, force: true })
  rmSync(statePathOf(root, target, mode), { force: true })
}

export const readAllStates = (root: string): readonly EnvironmentState[] => {
  const directory = join(root, '.dev-env')
  if (!existsSync(directory)) return []

  return readdirSync(directory).flatMap((key) => {
    const state = parseState(join(directory, key, 'state.json'), root)
    return state === undefined ? [] : [state]
  })
}
