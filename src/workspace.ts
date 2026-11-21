/*
 * What dev-env reads of the repository it runs in: the workspaces its
 * package manager knows, the names their package.json files give them, and
 * which package manager installs them. Each is read where it already lives,
 * so a repository configures nothing twice.
 */
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parse } from 'yaml'

import { DevEnvError } from './errors.ts'

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new DevEnvError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

interface PackageJson {
  readonly name?: unknown
  readonly packageManager?: unknown
  readonly type?: unknown
  readonly workspaces?: unknown
}

const packageJsonOf = (directory: string): PackageJson | undefined => {
  const file = join(directory, 'package.json')
  if (!existsSync(file)) return undefined
  const read = readJson(file)
  return typeof read === 'object' && read !== null ? read : undefined
}

/** Whether the package.json in a directory makes its TypeScript ES modules. */
export const isModulePackage = (directory: string): boolean =>
  packageJsonOf(directory)?.type === 'module'

/**
 * The package manager the root package.json's `packageManager` names, or
 * else the one whose lockfile the repository holds, or else npm.
 */
export const packageManagerOf = (root: string): PackageManager => {
  const named = packageJsonOf(root)?.packageManager
  if (typeof named === 'string') {
    const manager = /^(npm|pnpm|yarn)@/.exec(named)?.[1]
    if (manager !== undefined) return manager as PackageManager
  }
  return (
    LOCKFILES.find(([lockfile]) => existsSync(join(root, lockfile)))?.[1] ??
    'npm'
  )
}

const stringsIn = (value: unknown, source: string): readonly string[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new DevEnvError(`${source} must be a list of globs.`)
  return value as string[]
}

/**
 * The workspace globs of `pnpm-workspace.yaml`, or else of the root
 * package.json's `workspaces`, as a list or under `packages`.
 */
export const workspaceGlobsOf = (root: string): readonly string[] => {
  const pnpmWorkspace = join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpmWorkspace)) {
    const read = parse(readFileSync(pnpmWorkspace, 'utf8')) as {
      readonly packages?: unknown
    } | null
    return stringsIn(read?.packages, `The packages of ${pnpmWorkspace}`)
  }
  const workspaces = packageJsonOf(root)?.workspaces
  const source = `The workspaces of ${join(root, 'package.json')}`
  if (
    typeof workspaces === 'object' &&
    workspaces !== null &&
    !Array.isArray(workspaces)
  )
    return stringsIn((workspaces as { packages?: unknown }).packages, source)
  return stringsIn(workspaces, source)
}

const IN_NODE_MODULES = /(^|\/)node_modules(\/|$)/

const directoriesMatching = (root: string, glob: string): Set<string> =>
  new Set(
    globSync(glob.replace(/\/+$/, ''), {
      cwd: root,
      exclude: (path) => IN_NODE_MODULES.test(path),
    })
      .filter((path) => statSync(join(root, path)).isDirectory())
      .map((path) => join(root, path))
  )

/**
 * Every workspace directory, absolute and sorted: each directory a workspace
 * glob matches that holds a package.json, less those a `!` glob leaves out.
 */
export const workspaceDirectoriesOf = (root: string): readonly string[] => {
  const globs = workspaceGlobsOf(root)
  const included = new Set<string>()
  for (const pattern of globs.filter((glob) => !glob.startsWith('!')))
    for (const directory of directoriesMatching(root, pattern))
      included.add(directory)
  for (const pattern of globs.filter((glob) => glob.startsWith('!')))
    for (const directory of directoriesMatching(root, pattern.slice(1)))
      included.delete(directory)
  return [...included]
    .filter((directory) => directory !== root)
    .filter((directory) => existsSync(join(directory, 'package.json')))
    .toSorted()
}

/**
 * Each workspace package by the name its package.json gives it, with its
 * directory from the repository root, as `/libs/ui/`.
 */
export const workspacePackagesOf = (
  root: string
): ReadonlyMap<string, string> =>
  new Map(
    workspaceDirectoriesOf(root).flatMap((directory) => {
      const name = packageJsonOf(directory)?.name
      return typeof name === 'string'
        ? [[name, `/${relative(root, directory)}/`] as const]
        : []
    })
  )

/*
 * What the package manager installs every workspace from, so a change to one
 * may change any test environment.
 */
const PACKAGE_MANAGER_FILES: Readonly<
  Record<PackageManager, readonly string[]>
> = {
  npm: ['/package-lock.json', '/.npmrc'],
  pnpm: [
    '/pnpm-lock.yaml',
    '/pnpm-workspace.yaml',
    '/.npmrc',
    '/.pnpmfile.cjs',
  ],
  yarn: ['/yarn.lock', '/.yarnrc.yml', '/.yarnrc'],
}

/**
 * Repository paths every integration spec is built from without importing
 * them: the root package.json, compiler settings and Node version, and the
 * package manager's lockfile and workspace configuration.
 */
export const repositorySharedOf = (
  packageManager: PackageManager
): readonly string[] => [
  '/package.json',
  '/tsconfig.json',
  '/.nvmrc',
  '/.node-version',
  ...PACKAGE_MANAGER_FILES[packageManager],
]

// How each package manager runs a tool the repository installed, without fetching one it did not.
const RUNNERS: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ['npm', 'exec', '--no', '--'],
  pnpm: ['pnpm', 'exec'],
  yarn: ['yarn'],
}

/** The command that runs `bin`, installed in the repository, with `args`. */
export const commandOf = (
  packageManager: PackageManager,
  bin: string,
  args: readonly string[]
): readonly string[] => [...RUNNERS[packageManager], bin, ...args]

/** The command that runs the package.json script `script` of the package in the working directory, with `files` as its arguments. */
export const scriptCommandOf = (
  packageManager: PackageManager,
  script: string,
  files: readonly string[]
): readonly string[] =>
  packageManager === 'npm'
    ? ['npm', 'run', script, '--', ...files]
    : [packageManager, 'run', script, ...files]
