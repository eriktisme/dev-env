import type { Manifest } from '../manifest.ts'
import {
  packageManagerOf,
  repositorySharedOf,
  workspacePackagesOf,
} from '../workspace.ts'
import type { Layout } from './graph.ts'

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
  repository,
  processes: new Map(
    Object.entries(manifest.services).flatMap(([name, service]) =>
      service.kind === 'process' ? [[name, service.sources] as const] : []
    )
  ),
  packages: workspacePackagesOf(repository),
  shared: [
    ...TARGET_SHARED,
    ...repositorySharedOf(packageManagerOf(repository)),
    ...(manifest.shared ?? []),
  ],
})
