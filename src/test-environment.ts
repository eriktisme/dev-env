import type { Mode } from './checkout.ts'
import { isTestMode, resolveCheckout, testModeOf } from './checkout.ts'
import type { EnvironmentInfo } from './environment.ts'
import {
  resetTarget,
  startService,
  startTestTarget,
  stopService,
} from './environment.ts'
import type { Holder } from './slots.ts'
import {
  holderOf,
  releaseSlots,
  slotCountOnMachine,
  slotDirectoryOf,
  takeSlot,
} from './slots.ts'
import { readAllStates } from './state.ts'

export interface TestEnvironment {
  /** Unique on the machine; a process's telemetry carries it, to read a shared service by. */
  readonly name: string
  readonly services: EnvironmentInfo['services']
  /** Removes the environment's containers and volumes as well as stopping it. */
  readonly stop: () => Promise<void>
  /** Takes one service down, keeping its port and data, to trigger a failure. */
  readonly stopService: (service: string) => Promise<void>
  readonly startService: (service: string) => Promise<void>
}

export interface TestEnvironmentOptions {
  readonly cwd?: string
  /**
   * Which lane to use, so files that run side by side never share data. It
   * defaults to Vitest's worker number, which stays the same for every file a
   * worker runs, so each worker reuses its own lane.
   */
  readonly lane?: number
  /** Process services this test does not need, left stopped. */
  readonly without?: readonly string[]
  /** Settings the target's manifest reads when it starts each process, such as raised limits. */
  readonly settings?: Readonly<Record<string, string>>
  /**
   * Takes every lane slot on the machine until the file ends, for a file
   * whose results depend on timing. DEV_ENV_EXCLUSIVE=1 sets it, so a Vitest
   * project can give it to its files.
   */
  readonly exclusive?: boolean
}

let held: Holder | undefined

/*
 * Long enough to wait out another worktree's whole run, and short enough that
 * a holder that hangs does not keep a run waiting for good.
 */
const SLOT_WAIT_MS = 60 * 60 * 1000

/*
 * The slot belongs to this process, which runs one test file, so it frees
 * when the file ends however it ends; a process killed outright leaves a
 * record the next waiter sees is dead.
 */
export const holdSlotUntilExit = async (
  name: string,
  exclusive: boolean
): Promise<void> => {
  const directory = slotDirectoryOf()
  const holder = held ?? (await holderOf(name))
  if (held === undefined) {
    held = holder
    process.once('exit', () => releaseSlots(directory, holder))
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        releaseSlots(directory, holder)
        // With no other listener left, the signal ends the process as it would have.
        if (process.listenerCount(signal) === 0)
          process.kill(process.pid, signal)
      })
  }
  await takeSlot({
    directory,
    size: await slotCountOnMachine(),
    holder,
    exclusive,
    timeoutMs: SLOT_WAIT_MS,
    onWait: (reason) =>
      process.stderr.write(`${name} waits for a lane slot: ${reason}.\n`),
  })
}

export const isExclusiveByEnvironment = (): boolean =>
  process.env.DEV_ENV_EXCLUSIVE === '1'

export const laneOf = (lane: number | undefined): number => {
  const chosen = lane ?? Number(process.env.VITEST_POOL_ID ?? '1')
  return Number.isInteger(chosen) && chosen > 0 ? chosen : 1
}

/*
 * Starts with empty data, so a test never inherits rows or state from a file
 * before it or from a run that died. A lane already running keeps its
 * containers and ports, and only its data is thrown away, because starting
 * containers is most of what a fresh environment costs.
 */
export const startTestEnvironment = async (
  target: string,
  options: TestEnvironmentOptions = {}
): Promise<TestEnvironment> => {
  const cwd = options.cwd ?? process.cwd()
  const mode: Mode = testModeOf(laneOf(options.lane))
  await holdSlotUntilExit(
    `${target} ${mode} in ${cwd}`,
    options.exclusive ?? isExclusiveByEnvironment()
  )
  const { name, services } = await startTestTarget(cwd, target, mode, {
    without: options.without ?? [],
    settings: options.settings ?? {},
  })

  return {
    name,
    services,
    stop: () => resetTarget(cwd, target, mode),
    stopService: (service) => stopService(cwd, target, mode, service),
    startService: (service) => startService(cwd, target, mode, service),
  }
}

/** Removes every test lane of the checkout, or of one target, for the end of a run. */
export const resetTestEnvironments = async (
  options: { readonly cwd?: string; readonly target?: string } = {}
): Promise<void> => {
  const cwd = options.cwd ?? process.cwd()
  const checkout = await resolveCheckout(cwd)
  await Promise.all(
    readAllStates(checkout.root)
      .filter(
        (state) =>
          isTestMode(state.mode) &&
          (options.target === undefined || state.target === options.target)
      )
      .map((state) => resetTarget(cwd, state.target, state.mode))
  )
}
