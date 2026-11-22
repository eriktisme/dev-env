import { basename, join, relative } from 'node:path'

import { DevEnvError } from '../errors.ts'
import type { Manifest } from '../manifest.ts'
import {
  packageManagerOf,
  repositorySharedOf,
  workspacePackagesOf,
} from '../workspace.ts'
import type { Layout } from './graph.ts'
import type { SpecLists } from './select.ts'

/*
 * What every test environment of a target is built from without importing
 * it: its manifest, its services, and the settings that compile and run its
 * specs. A change to one runs every spec. Paths are relative to the target.
 */
export const TARGET_SHARED: readonly string[] = [
  'dev-env.ts',
  'compose.yaml',
  'compose.test.yaml',
  'package.json',
  'tsconfig.json',
  // A target's shared compiler options, such as its import aliases.
  'tsconfig.*.json',
  'vitest.integration.ts',
]

/*
 * What every spec of a consumer package is built from without importing it:
 * the settings that compile and run it. Paths are relative to the package.
 */
export const CONSUMER_SHARED: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'tsconfig.*.json',
  'vitest.config.*',
  'vite.config.*',
]

/**
 * The layout of the target in `target`, inside the repository in
 * `repository`: its processes and their sources from its manifest, the
 * repository's workspace packages, and every path shared by all its specs,
 * the target's own, the repository's and its package manager's, and those
 * the manifest's `shared` adds.
 */
export const layoutOf = (
  target: string,
  repository: string,
  manifest: Manifest
): Layout => ({
  target,
  name: basename(target),
  repository,
  processes: new Map(
    Object.entries(manifest.services).flatMap(([name, service]) =>
      service.kind === 'compose' ? [] : [[name, service.sources] as const]
    )
  ),
  packages: workspacePackagesOf(repository),
  shared: [
    ...TARGET_SHARED,
    ...repositorySharedOf(packageManagerOf(repository)),
    ...(manifest.shared ?? []),
  ],
})

/** One consumer package of a target: where its specs are, the script that runs them, and its layout. */
export interface Group {
  /** The package's name. */
  readonly name: string
  /** The package's directory. */
  readonly directory: string
  /** The package.json script that runs the chosen specs, given as arguments. */
  readonly script: string
  readonly specs: SpecLists
  readonly layout: Layout
}

// A target's path, as one from the repository, so that a layout of another directory reads it.
const fromRepository = (target: string, repository: string, path: string) =>
  path.startsWith('/') ? path : `/${join(relative(repository, target), path)}`

/**
 * The layouts of the packages the manifest's `consumers` names, in name
 * order. Each reads its specs from its own package, and the target's
 * processes and shared paths as paths from the repository.
 */
export const consumerLayoutsOf = (
  target: string,
  repository: string,
  manifest: Manifest
): readonly Group[] => {
  const consumers = Object.entries(manifest.consumers ?? {}).toSorted(
    ([a], [b]) => a.localeCompare(b)
  )
  if (consumers.length === 0) return []
  const packages = workspacePackagesOf(repository)
  const own = layoutOf(target, repository, manifest)
  return consumers.map(([name, consumer]) => {
    const found = packages.get(name)
    if (found === undefined)
      throw new DevEnvError(
        `The consumer "${name}" of the target "${basename(target)}" is not a workspace package of the repository. Name it as its package.json does.`
      )
    const directory = join(repository, found.replace(/\/$/, ''))
    if (directory === target)
      throw new DevEnvError(
        `The target "${basename(target)}" lists itself as a consumer. Its own specs are always chosen.`
      )
    return {
      name,
      directory,
      script: consumer.script ?? 'tests:integration',
      specs: consumer.specs ?? {},
      layout: {
        ...own,
        target: directory,
        processes: new Map(
          [...own.processes].map(([process, sources]) => [
            process,
            sources.map((source) => fromRepository(target, repository, source)),
          ])
        ),
        shared: [
          ...repositorySharedOf(packageManagerOf(repository)),
          ...[...TARGET_SHARED, ...(manifest.shared ?? [])].map((glob) =>
            fromRepository(target, repository, glob)
          ),
          ...CONSUMER_SHARED,
          ...(consumer.shared ?? []),
        ],
      },
    }
  })
}
