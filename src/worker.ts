import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { DevEnvError } from './errors.ts'
import type { WorkerService } from './manifest.ts'

/*
 * One `wrangler dev --local` process runs every config of a worker service in
 * a single Miniflare, which is what lets a producer's Queue reach a consumer
 * in another Worker: the queue broker lives inside that process, so Workers in
 * separate processes never see each other's messages. Service bindings, Durable
 * Objects, R2, KV and Workflows share the same process and one persist path.
 */

interface WranglerConfig {
  name?: unknown
  main?: unknown
  base_dir?: unknown
  assets?: { directory?: unknown }
  build?: { cwd?: unknown }
  env?: Record<string, WranglerConfig>
  [key: string]: unknown
}

export interface PreparedWorker {
  readonly name: string
  readonly configPath: string
}

const readConfig = (path: string): WranglerConfig => {
  if (!path.endsWith('.json'))
    throw new DevEnvError(
      `${path} is not a .json file. A worker service reads JSON wrangler configs, so generate one from TOML or JSONC first.`
    )
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WranglerConfig
  } catch (error) {
    throw new DevEnvError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/*
 * The copy lives beside its bindings file, in the environment's data
 * directory, so every path in it that was relative to the original must say
 * where that is.
 */
const absolutize = (config: WranglerConfig, from: string): WranglerConfig => {
  const absolute = (value: unknown): unknown =>
    typeof value === 'string' && !isAbsolute(value)
      ? resolve(from, value)
      : value
  const copy: WranglerConfig = { ...config }
  if ('main' in copy) copy.main = absolute(copy.main)
  if ('base_dir' in copy) copy.base_dir = absolute(copy.base_dir)
  if (copy.assets?.directory !== undefined)
    copy.assets = { ...copy.assets, directory: absolute(copy.assets.directory) }
  if (copy.build?.cwd !== undefined)
    copy.build = { ...copy.build, cwd: absolute(copy.build.cwd) }
  if (copy.env !== undefined)
    copy.env = Object.fromEntries(
      Object.entries(copy.env).map(([name, env]) => [
        name,
        absolutize(env, from),
      ])
    )
  return copy
}

/** A `.dev.vars` file, which Wrangler parses as dotenv; JSON strings are valid double-quoted values. */
export const devVarsOf = (bindings: Readonly<Record<string, string>>): string =>
  Object.entries(bindings)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
    .join('')

/*
 * Wrangler reads `.dev.vars` beside each config, and never the shell's
 * environment, so the bindings a Worker sees are exactly the ones written
 * here. The files go under the environment's data directory, never beside the
 * source, and are readable by their owner only.
 */
export const prepareWorkers = async ({
  service,
  directory,
  workDirectory,
  bindings,
}: {
  readonly service: WorkerService
  readonly directory: string
  readonly workDirectory: string
  readonly bindings: (
    worker: string
  ) => Promise<Readonly<Record<string, string>>>
}): Promise<readonly PreparedWorker[]> => {
  if (service.configs.length === 0)
    throw new DevEnvError('A worker service needs at least one config.')

  const prepared: PreparedWorker[] = []
  for (const file of service.configs) {
    const original = resolve(directory, file)
    const config = readConfig(original)
    if (typeof config.name !== 'string' || config.name === '')
      throw new DevEnvError(`${original} has no "name".`)
    if (prepared.some(({ name }) => name === config.name))
      throw new DevEnvError(
        `Two configs of a worker service are both named "${config.name}".`
      )

    const folder = join(workDirectory, config.name)
    mkdirSync(folder, { recursive: true })
    const configPath = join(folder, 'wrangler.json')
    writeFileSync(
      configPath,
      JSON.stringify(absolutize(config, dirname(original)), null, 2)
    )
    writeFileSync(
      join(folder, '.dev.vars'),
      devVarsOf(await bindings(config.name)),
      { mode: 0o600 }
    )
    prepared.push({ name: config.name, configPath })
  }
  return prepared
}

/*
 * Resolved from the target, so the repository chooses the version. The first
 * config is the primary Worker: it answers on the service's port, and the
 * others are reachable through its service bindings and queues. The inspector
 * port is left to Wrangler to take, as it only serves a debugger.
 */
export const workerCommandOf = ({
  directory,
  port,
  persistDirectory,
  workers,
}: {
  readonly directory: string
  readonly port: number
  readonly persistDirectory: string
  readonly workers: readonly PreparedWorker[]
}): readonly string[] => {
  let wrangler: string
  try {
    const manifest = createRequire(join(directory, 'package.json')).resolve(
      'wrangler/package.json'
    )
    wrangler = join(dirname(manifest), 'bin', 'wrangler.js')
  } catch {
    throw new DevEnvError(
      `A worker service runs Wrangler, which ${directory} cannot resolve. Add \`wrangler\` to its dependencies.`
    )
  }
  return [
    process.execPath,
    wrangler,
    'dev',
    '--local',
    ...workers.flatMap(({ configPath }) => ['--config', configPath]),
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    '0',
    '--persist-to',
    persistDirectory,
  ]
}

/** Stops Wrangler asking, reporting or opening anything: nothing here talks to an account. */
export const WORKER_ENVIRONMENT: Readonly<Record<string, string>> = {
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_HIDE_BANNER: 'true',
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_ACCOUNT_ID: '',
}
