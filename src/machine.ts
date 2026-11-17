import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/*
 * What every checkout on this machine shares: the lane slots and the shared
 * services. DEV_ENV_HOME moves it, so dev-env's own tests share nothing with
 * real runs.
 */
export const machineDirectoryOf = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const directory =
    environment.DEV_ENV_HOME ??
    join(environment.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dev-env')
  mkdirSync(directory, { recursive: true })
  return directory
}

/** Tells apart the machine directories, so a test's shared services are never a real run's. */
export const machineIdOf = (directory: string): string =>
  createHash('sha256').update(directory).digest('hex').slice(0, 8)
