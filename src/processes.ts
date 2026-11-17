import { execFile, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { DevEnvError } from './errors.ts'
import type { RecordedProcess } from './state.ts'

const run = promisify(execFile)

const STOP_GRACE_MS = 5_000
const POLL_MS = 100

export const startTimeOf = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/*
 * The start time is what stops a recycled pid from being mistaken for this
 * process, so an unrelated program is never signalled.
 */
export const isLeaderLive = async (
  recorded: RecordedProcess
): Promise<boolean> => (await startTimeOf(recorded.pid)) === recorded.startedAt

/*
 * A wrapper such as pnpm can die and leave its server running. A group id alone
 * could be a stranger's after a reboot, so a survivor must also hold this
 * process's log open, which it inherited at spawn. Without lsof this finds no
 * survivors, leaving a process running rather than signalling the wrong one.
 */
const hasSurvivors = async (recorded: RecordedProcess): Promise<boolean> => {
  try {
    const { stdout } = await run('lsof', [
      '-a',
      '-g',
      String(recorded.pid),
      '-t',
      '--',
      recorded.logPath,
    ])
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

export const isRecordedProcessLive = async (
  recorded: RecordedProcess
): Promise<boolean> => {
  const startedAt = await startTimeOf(recorded.pid)
  if (startedAt !== undefined) return startedAt === recorded.startedAt
  return hasSurvivors(recorded)
}

export interface StartProcessOptions {
  readonly command: readonly string[]
  readonly directory: string
  readonly environment: Readonly<Record<string, string>>
  readonly logPath: string
}

export const startProcess = async (
  options: StartProcessOptions
): Promise<RecordedProcess> => {
  const [program, ...args] = options.command
  if (program === undefined) {
    throw new DevEnvError('A process service needs a command.')
  }

  mkdirSync(dirname(options.logPath), { recursive: true })
  const log = openSync(options.logPath, 'w')
  const child = spawn(program, args, {
    cwd: options.directory,
    detached: true,
    env: { ...process.env, ...options.environment },
    stdio: ['ignore', log, log],
  })
  closeSync(log)

  const pid = await new Promise<number>((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid ?? 0))
    child.once('error', (error) =>
      reject(new DevEnvError(`Could not run ${program}: ${error.message}`))
    )
  })
  child.unref()

  const startedAt = await startTimeOf(pid)
  if (startedAt === undefined) {
    throw new DevEnvError(`${program} exited as soon as it started.`)
  }

  return { pid, startedAt, logPath: options.logPath }
}

const isGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    // macOS answers EPERM rather than ESRCH once every member has exited but is not yet reaped.
    const { code } = error as NodeJS.ErrnoException
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

export const stopProcess = async (recorded: RecordedProcess): Promise<void> => {
  if (!(await isRecordedProcessLive(recorded))) return

  signalGroup(recorded.pid, 'SIGTERM')
  const deadline = Date.now() + STOP_GRACE_MS
  while (isGroupAlive(recorded.pid) && Date.now() < deadline) {
    await sleep(POLL_MS)
  }
  signalGroup(recorded.pid, 'SIGKILL')
}

export const tailOf = (path: string, lines: number): string => {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}
