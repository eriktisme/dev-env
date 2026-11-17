import { createHash } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { DevEnvError } from './errors.ts'

export const LOOPBACK = '127.0.0.1'

/* Below every platform's ephemeral range, so outbound connections never take one. */
const FIRST_PORT = 20_000
const PORT_COUNT = 10_000

const LOCK_TIMEOUT_MS = 15_000
const LOCK_RETRY_MS = 50

export const preferredPortOf = (seed: string): number =>
  FIRST_PORT +
  (createHash('sha256').update(seed).digest().readUInt32BE(0) % PORT_COUNT)

export const choosePort = async (
  preferred: number,
  isTaken: (port: number) => boolean | Promise<boolean>
): Promise<number> => {
  for (let offset = 0; offset < PORT_COUNT; offset += 1) {
    const candidate =
      FIRST_PORT + ((preferred - FIRST_PORT + offset) % PORT_COUNT)
    if (!(await isTaken(candidate))) return candidate
  }

  throw new DevEnvError(
    `No free port between ${FIRST_PORT} and ${FIRST_PORT + PORT_COUNT - 1}.`
  )
}

const answersOnPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port, timeout: 250 })
    const settle = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })

const canBindPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, LOOPBACK, () => {
      server.close(() => resolve(true))
    })
  })

/*
 * Both checks are needed: macOS lets a loopback bind succeed beside a wildcard
 * listener, and a socket in the backlog can refuse a connection yet hold the port.
 */
export const isPortInUse = async (port: number): Promise<boolean> =>
  (await answersOnPort(port)) || !(await canBindPort(port))

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const removeLockIfAbandoned = async (path: string): Promise<void> => {
  const holder = Number(await readFile(path, 'utf8').catch(() => ''))
  if (holder > 0 && !isProcessAlive(holder)) {
    await unlink(path).catch(() => undefined)
  }
}

/*
 * A file created exclusively, holding the holder's pid, so a holder that died
 * leaves nothing a waiter cannot remove.
 */
export const withLock = async <T>(
  path: string,
  timeoutMs: number,
  work: () => Promise<T>
): Promise<T> => {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() > deadline) {
        throw new DevEnvError(`Could not take the lock at ${path}.`)
      }
      await removeLockIfAbandoned(path)
      await sleep(LOCK_RETRY_MS)
    }
  }

  try {
    return await work()
  } finally {
    await unlink(path).catch(() => undefined)
  }
}

/*
 * Lives in the git common directory because that is the one place every
 * worktree of a repository shares.
 */
export const withAllocationLock = <T>(
  gitCommonDirectory: string,
  work: () => Promise<T>
): Promise<T> =>
  withLock(
    join(gitCommonDirectory, 'dev-env-allocation.lock'),
    LOCK_TIMEOUT_MS,
    work
  )
