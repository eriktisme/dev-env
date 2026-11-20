/*
 * A Vitest setup file, which takes the test file's lane slot before any of
 * its hooks run. Vitest puts no timeout on a setup file, so waiting for a slot
 * that another run holds never counts against the hook that starts the test
 * environment, whose clock starts once the slot is held. startTestEnvironment
 * then finds the slot already this process's.
 */
import { testModeOf } from './checkout.ts'
import {
  holdSlotUntilExit,
  isExclusiveByEnvironment,
  laneOf,
} from './test-environment.ts'

await holdSlotUntilExit(
  `${testModeOf(laneOf(undefined))} in ${process.cwd()}`,
  isExclusiveByEnvironment()
)
