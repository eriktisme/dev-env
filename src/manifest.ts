import { existsSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { getTsconfig } from 'get-tsconfig'
import { register as registerCommonJs } from 'tsx/cjs/api'
import { register as registerModule } from 'tsx/esm/api'

import { DevEnvError } from './errors.ts'
import { isModulePackage, workspaceDirectoriesOf } from './workspace.ts'

const MANIFEST = 'dev-env.ts'

export interface CommandContext {
  /** Names this environment uniquely on the machine, to tell its data apart in a shared service. */
  readonly environmentName: string
  /**
   * What a test asked its environment for, such as raised limits, by names
   * the manifest gives them. Empty for a dev environment, so nothing a test
   * asks for reaches one, or anything deployed.
   */
  readonly settings: Readonly<Record<string, string>>
  readonly port: number
  readonly ports: Readonly<Record<string, number>>
  /** Where the process keeps its own data. It survives a stop and goes on reset. */
  readonly dataDirectory: string
}

export interface ProcessService {
  readonly kind: 'process'
  readonly command: (context: CommandContext) => readonly string[]
  /** The path that answers below 400 once the service is usable. */
  readonly readinessPath: string
  readonly timeoutMs?: number
  /**
   * The directories, relative to the target, holding the code this process
   * runs, such as a Worker's own and any it loads beside it. A change under
   * one, or to a file their code imports, reaches every integration spec
   * that starts this process.
   */
  readonly sources: readonly string[]
}

export interface WorkerBindingsContext extends CommandContext {
  /** The `name` of the Worker whose bindings are being written. */
  readonly worker: string
  /**
   * The address, `127.0.0.1:<port>`, of a service that another target of this
   * checkout and mode is running, such as its database. It fails the start if
   * that service is not running, so a Worker never starts pointed at nothing.
   */
  readonly addressOf: (target: string, service: string) => Promise<string>
}

/**
 * Runs Workers locally with Wrangler's Miniflare. Every config runs in one
 * process, so their Queues, Durable Objects, R2 buckets, KV namespaces,
 * Workflows and service bindings all see each other, and what they persist
 * lives in the environment's data directory.
 */
export interface WorkerService {
  readonly kind: 'worker'
  /**
   * Wrangler configs, as JSON files relative to the target. The first is the
   * primary Worker, which answers on the service's port, and the rest are
   * reached through its service bindings and the queues they consume.
   */
  readonly configs: readonly string[]
  /**
   * The bindings of one Worker, which Wrangler gets as its `.dev.vars`. They
   * are the only variables and secrets a Worker sees: nothing is read from
   * the shell's environment. Called for each Worker on every start.
   */
  readonly bindings?: (
    context: WorkerBindingsContext
  ) =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>
  /** The path that answers below 400 on the primary Worker once it is usable. */
  readonly readinessPath: string
  readonly timeoutMs?: number
  /** As for a process: the directories, relative to the target, holding the code the Workers run. */
  readonly sources: readonly string[]
}

/** Named after its service in the target's compose.yaml. */
export interface ComposeService {
  readonly kind: 'compose'
  readonly timeoutMs?: number
  /**
   * One container for every checkout, mode and lane on the machine, started
   * the first time any of them needs it and kept. Only for a service whose
   * data a reader can tell apart by its own environment, IDs and time, such
   * as telemetry.
   */
  readonly shared?: boolean
}

export type Service = ProcessService | WorkerService | ComposeService

export interface SetupContext {
  readonly ports: Readonly<Record<string, number>>
}

/** A workspace package whose integration specs use the target's test environment. */
export interface Consumer {
  /** The package.json script that runs the chosen specs, given as arguments. Defaults to `tests:integration`. */
  readonly script?: string
  /**
   * Globs, relative to the package or from the repository with a leading `/`,
   * for what its specs are built from without importing it. A change to one
   * runs every integration spec of the package.
   */
  readonly shared?: readonly string[]
  /** Globs, relative to the package, for its specs a pull request always runs, and those only the full suite runs before a release. */
  readonly specs?: {
    readonly always?: readonly string[]
    readonly beforeRelease?: readonly string[]
  }
}

export interface Manifest {
  readonly services: Readonly<Record<string, Service>>
  /**
   * Globs, relative to the target or from the repository with a leading `/`,
   * for what the target's test environments are built from without importing
   * it, such as migrations. A change to one runs every integration spec.
   */
  readonly shared?: readonly string[]
  /**
   * Integration specs, as globs relative to the target, that a pull request's
   * affected run always holds, such as the product's own scenarios, and those
   * it never holds, which only the full suite runs before a release, such as
   * a paced replay.
   */
  readonly specs?: {
    readonly always?: readonly string[]
    readonly beforeRelease?: readonly string[]
  }
  /**
   * The workspace packages, by the name their package.json gives them, whose
   * integration specs use this target's test environment. `dev-env affected`
   * chooses their specs too, each package in a group of its own.
   */
  readonly consumers?: Readonly<Record<string, Consumer>>
  /**
   * Runs on every dev start, once the compose services are healthy and before
   * any process starts, so it must be safe to run again, as migrations are.
   * Test environments skip it, because each test file sets up its own data.
   */
  readonly setup?: (context: SetupContext) => Promise<void>
  /**
   * Runs on every dev start once every process is ready, for data only a
   * running process can make, such as people a stand-in directory holds. It
   * must be safe to run again, and test environments skip it as they skip
   * setup.
   */
  readonly afterStart?: (context: SetupContext) => Promise<void>
  /**
   * Settings every test environment of the target starts with, such as a
   * feature flag on, under the ones a spec asks for, which win. A dev
   * environment never gets them.
   */
  readonly testSettings?: Readonly<Record<string, string>>
}

export interface Target {
  readonly name: string
  readonly directory: string
  readonly manifest: Manifest
}

export const defineManifest = (manifest: Manifest): Manifest => manifest

/** A test environment's settings: the target's defaults, then what the spec asked for. */
export const testSettingsOf = (
  manifest: Manifest,
  asked: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => ({ ...manifest.testSettings, ...asked })

export const portVariableOf = (service: string): string =>
  `${service.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_PORT`

export const portVariablesOf = (
  ports: Readonly<Record<string, number>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(ports).map(([service, port]) => [
      portVariableOf(service),
      String(port),
    ])
  )

/*
 * Each workspace directory that holds a dev-env.ts, by its directory's name,
 * which is all a command gives. Two with one name would make a command
 * ambiguous, so they are refused.
 */
const targetDirectoriesOf = (root: string): ReadonlyMap<string, string> => {
  const targets = new Map<string, string>()
  for (const directory of workspaceDirectoriesOf(root)) {
    if (!existsSync(join(directory, MANIFEST))) continue
    const name = basename(directory)
    const other = targets.get(name)
    if (other !== undefined)
      throw new DevEnvError(
        `${relative(root, other)} and ${relative(root, directory)} are both named "${name}". Rename one of the directories, since a target is named after its directory.`
      )
    targets.set(name, directory)
  }
  return targets
}

/** The targets of the repository: its workspaces with a dev-env.ts. */
export const availableTargets = (root: string): readonly string[] =>
  [...targetDirectoriesOf(root).keys()].toSorted()

/*
 * A manifest is TypeScript that may import more of it, without extensions
 * and through the paths of the tsconfig.json nearest it, so tsx loads it
 * rather than Node. A loader is registered once a process for each such
 * tsconfig and module format, under a namespace of its own, so it reaches
 * nothing else the process imports.
 *
 * tsx compiles the TypeScript of a package that is not `"type": "module"` to
 * CommonJS. Its ES module loader hands such a file on to a CommonJS loader
 * that ignores the paths of its tsconfig.json, and from Node 24.18 cannot
 * find the file at all, so a manifest there goes through tsx's CommonJS
 * loader instead. That one reads its tsconfig.json from TSX_TSCONFIG_PATH as
 * it registers, and without one, from the working directory.
 */
type Load = (file: string) => Promise<unknown>

const moduleLoader = (
  namespace: string,
  tsconfig: string | undefined
): Load => {
  const loader = registerModule({ namespace, tsconfig: tsconfig ?? false })
  return async (file) =>
    loader.import(pathToFileURL(file).href, import.meta.url)
}

const commonJsLoader = (
  namespace: string,
  tsconfig: string | undefined
): Load => {
  const previous = process.env.TSX_TSCONFIG_PATH
  if (tsconfig !== undefined) process.env.TSX_TSCONFIG_PATH = tsconfig
  try {
    const loader = registerCommonJs({ namespace })
    return async (file) => loader.require(file, import.meta.url) as unknown
  } finally {
    if (previous === undefined) delete process.env.TSX_TSCONFIG_PATH
    else process.env.TSX_TSCONFIG_PATH = previous
  }
}

const loaders = new Map<string, Load>()

const loaderFor = (file: string): Load => {
  const tsconfig = getTsconfig(dirname(file))?.path
  const isModule = isModulePackage(dirname(file))
  const key = `${isModule ? 'module' : 'commonjs'}:${tsconfig ?? ''}`
  let loader = loaders.get(key)
  if (loader === undefined) {
    const namespace = `dev-env-${loaders.size}`
    loader = isModule
      ? moduleLoader(namespace, tsconfig)
      : commonJsLoader(namespace, tsconfig)
    loaders.set(key, loader)
  }
  return loader
}

interface Loaded {
  readonly default?: unknown
}

const importManifest = async (file: string): Promise<Manifest> => {
  const loaded = (await loaderFor(file)(file)) as Loaded
  const manifest = loaded.default
  if (typeof manifest !== 'object' || manifest === null)
    throw new DevEnvError(
      `${file} has no default export. Export its manifest with \`export default defineManifest({ ... })\`.`
    )
  return manifest as Manifest
}

export const loadTarget = async (
  root: string,
  name: string
): Promise<Target> => {
  const targets = targetDirectoriesOf(root)
  const directory = targets.get(name)

  if (directory === undefined) {
    const known = [...targets.keys()].toSorted().join(', ') || 'none'
    throw new DevEnvError(
      `Unknown target "${name}". Available: ${known}. A target is a workspace directory with a ${MANIFEST}.`
    )
  }

  return {
    name,
    directory,
    manifest: await importManifest(join(directory, MANIFEST)),
  }
}
