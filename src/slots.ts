import { execFile } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { DevEnvError } from './errors.ts'
import { machineDirectoryOf } from './machine.ts'
import { startTimeOf } from './processes.ts'

const run = promisify(execFile)

/*
 * A lane's containers are Postgres and a proxy, about 150 MB together, which
 * grows with the rows a file writes; the shared telemetry stack is about 1 GB.
 */
const LANE_MEMORY_BYTES = 384 * 1024 ** 2
const SHARED_MEMORY_BYTES = 1024 ** 3
/*
 * Each lane also runs its Workers on the host, up to nine wrangler processes,
 * and lanes beyond the host's cores slowed each other until tests timed out.
 */
const CORES_PER_LANE = 3
const POLL_MS = 250

const EXCLUSIVE = 'exclusive.json'

export interface Holder {
  readonly pid: number
  readonly startedAt: string
  /** What the holder runs, to say who a waiter waits for. */
  readonly name: string
}

export const slotDirectoryOf = (): string => {
  const directory = join(machineDirectoryOf(), 'lanes')
  mkdirSync(directory, { recursive: true })
  return directory
}

export const holderOf = async (
  name: string,
  pid = process.pid
): Promise<Holder> => {
  const startedAt = await startTimeOf(pid)
  if (startedAt === undefined)
    throw new DevEnvError(`Process ${pid} is not running.`)
  return { pid, startedAt, name }
}

/*
 * The memory Docker has, less the shared stack, in lanes, and no more lanes
 * than the host's cores carry. DEV_ENV_LANE_SLOTS overrides both.
 */
export const slotCountOf = (
  override: string | undefined,
  dockerMemoryBytes: number,
  cores: number
): number => {
  if (override !== undefined && override !== '') {
    const count = Number(override)
    if (!Number.isInteger(count) || count < 1)
      throw new DevEnvError(
        `DEV_ENV_LANE_SLOTS must be a whole number above 0, not "${override}".`
      )
    return count
  }
  const byMemory = Math.floor(
    (dockerMemoryBytes - SHARED_MEMORY_BYTES) / LANE_MEMORY_BYTES
  )
  return Math.max(1, Math.min(byMemory, Math.floor(cores / CORES_PER_LANE)))
}

let slotCount: Promise<number> | undefined

export const slotCountOnMachine = (): Promise<number> => {
  slotCount ??= (async () => {
    const { stdout } = await run('docker', [
      'info',
      '--format',
      '{{.MemTotal}}',
    ])
    return slotCountOf(
      process.env.DEV_ENV_LANE_SLOTS,
      Number(stdout.trim()),
      availableParallelism()
    )
  })()
  return slotCount
}

const read = (path: string): Holder | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Holder
  } catch {
    return undefined
  }
}

const isSame = (a: Holder, b: Holder): boolean =>
  a.pid === b.pid && a.startedAt === b.startedAt

/*
 * Written to a private file and linked into place, so a reader never finds a
 * half-written holder and only one creator wins the name.
 */
const tryCreate = (path: string, holder: Holder): boolean => {
  const draft = `${path}.${holder.pid}.tmp`
  writeFileSync(draft, JSON.stringify(holder))
  try {
    linkSync(draft, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(draft, { force: true })
  }
}

interface Held {
  readonly file: string
  readonly holder: Holder
}

/* Every record, with those of a holder that died, or whose pid was reused, removed. */
const liveRecords = async (directory: string): Promise<Held[]> => {
  const held: Held[] = []
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue
    const holder = read(join(directory, file))
    if (holder === undefined) continue
    if ((await startTimeOf(holder.pid)) === holder.startedAt)
      held.push({ file, holder })
    else rmSync(join(directory, file), { force: true })
  }
  return held
}

const describeHolders = (held: readonly Held[]): string =>
  [...new Map(held.map(({ holder }) => [holder.pid, holder])).values()]
    .map(({ name, pid }) => `${name} (pid ${pid})`)
    .join(', ')

const durationOf = (ms: number): string =>
  ms < 60_000 ? `${ms / 1000} seconds` : `${Math.round(ms / 60_000)} minutes`

export interface TakeSlotOptions {
  readonly directory: string
  readonly size: number
  readonly holder: Holder
  /** Every slot on the machine, so nothing else runs beside a file that measures time. */
  readonly exclusive?: boolean
  readonly onWait?: (reason: string) => void
  /** How long to wait before giving up, saying who holds the slots. */
  readonly timeoutMs?: number
}

/*
 * Returns once the holder has a slot, or every slot when exclusive. While one
 * holder waits to run alone, no one else takes a slot, so it waits only for
 * the files already running. A holder waiting holds nothing, so two that both
 * want every slot never wait on each other, and one that already runs keeps
 * its slot, since the holder waiting to run alone is waiting for it.
 */
export const takeSlot = async ({
  directory,
  size,
  holder,
  exclusive = false,
  onWait = () => undefined,
  timeoutMs = Number.POSITIVE_INFINITY,
}: TakeSlotOptions): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastReason = ''
  const wait = async (reason: string): Promise<void> => {
    if (Date.now() >= deadline)
      throw new DevEnvError(
        `No lane slot came free in ${durationOf(timeoutMs)}: ${reason}.`
      )
    if (reason !== lastReason) onWait(reason)
    lastReason = reason
    await sleep(POLL_MS)
  }

  for (;;) {
    const held = await liveRecords(directory)
    const marker = held.find(({ file }) => file === EXCLUSIVE)
    const slots = held.filter(({ file }) => file !== EXCLUSIVE)
    const ours = slots.filter((slot) => isSame(slot.holder, holder))
    if (!exclusive && ours.length > 0) return

    if (marker !== undefined && !isSame(marker.holder, holder)) {
      if (ours.length > 0) releaseSlots(directory, holder)
      await wait(`${describeHolders([marker])} is running alone`)
      continue
    }

    if (!exclusive) {
      const free = Array.from({ length: size }, (_, i) => `slot-${i}.json`)
        .filter((file) => !slots.some((slot) => slot.file === file))
        .find((file) => tryCreate(join(directory, file), holder))
      if (free !== undefined) return
      await wait(`all ${size} lane slots are held by ${describeHolders(slots)}`)
      continue
    }

    if (marker === undefined) {
      tryCreate(join(directory, EXCLUSIVE), holder)
      continue
    }
    for (let i = 0; i < size; i++)
      if (!slots.some((slot) => slot.file === `slot-${i}.json`))
        tryCreate(join(directory, `slot-${i}.json`), holder)
    const others = (await liveRecords(directory)).filter(
      (record) => !isSame(record.holder, holder)
    )
    if (others.length === 0) return
    await wait(`waiting to run alone until ${describeHolders(others)} finish`)
  }
}

/** Synchronous, so it can run as the process exits. */
export const releaseSlots = (directory: string, holder: Holder): void => {
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue
    const recorded = read(join(directory, file))
    if (recorded !== undefined && isSame(recorded, holder))
      rmSync(join(directory, file), { force: true })
  }
}
