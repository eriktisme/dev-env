import { join } from 'node:path'

import { type Graph, isRuntime, type Reach, type Route } from './graph.ts'

export type Selection =
  | { readonly kind: 'everything'; readonly because: readonly string[] }
  | {
      readonly kind: 'specs'
      /** Each chosen spec, with the changed paths that chose it. */
      readonly specs: ReadonlyMap<string, readonly string[]>
    }

const SPECIAL = /\*\*\/|\*\*|\*|[.+?^${}()|[\]\\]/g

const patternOf = (glob: string): RegExp =>
  new RegExp(
    `^${glob.replace(SPECIAL, (token) => {
      if (token === '**/') return '(?:.*/)?'
      if (token === '**') return '.*'
      if (token === '*') return '[^/]*'
      return `\\${token}`
    })}$`
  )

export const matches = (glob: string, path: string): boolean =>
  patternOf(glob).test(path)

/** The specs the patterns name: each glob's matches among `allSpecs`, and each literal path as written. */
export const expandSpecs = (
  patterns: readonly string[],
  allSpecs: readonly string[]
): string[] => [
  ...new Set(
    patterns.flatMap((pattern) =>
      pattern.includes('*')
        ? allSpecs.filter((spec) => matches(pattern, spec))
        : [pattern]
    )
  ),
]

const describe = (path: string, route: Route): string =>
  route.kind === 'imports'
    ? `${path}, imported by the spec`
    : `${path}, through ${route.process}`

const routeTo = (reach: Reach, path: string): Route | undefined => {
  const file = reach.files.get(path)
  if (file !== undefined) return file
  if (!isRuntime(path)) return undefined
  for (const [directory, route] of reach.directories)
    if (path.startsWith(directory)) return route
  return undefined
}

/**
 * Chooses the integration specs that `changed` reaches in `graph`. A changed
 * spec runs itself, a path the graph's `shared` globs match runs every spec,
 * and a path no spec reaches runs nothing.
 */
export const selectSpecs = (
  graph: Graph,
  changed: readonly string[]
): Selection => {
  const everything: string[] = []
  const chosen = new Map<string, string[]>()
  const choose = (spec: string, reason: string) =>
    chosen.set(spec, [...(chosen.get(spec) ?? []), reason])

  for (const path of changed) {
    // Tests, stories and docs run nowhere, even inside a shared directory.
    if (!graph.specs.has(path) && !isRuntime(path)) continue
    const repositoryPath = path.startsWith('/')
      ? path
      : `/${join(graph.directory, path)}`
    const shared = graph.shared.find((glob) =>
      matches(glob, glob.startsWith('/') ? repositoryPath : path)
    )
    if (shared !== undefined) {
      everything.push(`${path} is shared, as ${shared}`)
      continue
    }
    for (const [spec, reach] of graph.specs) {
      if (path === spec) {
        choose(spec, path)
        continue
      }
      const route = routeTo(reach, path)
      if (route !== undefined) choose(spec, describe(path, route))
    }
  }

  if (everything.length > 0) return { kind: 'everything', because: everything }
  return {
    kind: 'specs',
    specs: new Map([...chosen].sort(([a], [b]) => a.localeCompare(b))),
  }
}

/** Integration spec globs a pull request runs whatever it changes, and those it leaves to the full suite before a release. */
export interface SpecLists {
  readonly always?: readonly string[]
  readonly beforeRelease?: readonly string[]
}

/**
 * The specs a pull request runs, each with why: those its changes reach, or
 * every spec when they reach shared code, and every spec it always runs,
 * less those only the full suite runs.
 */
export const forPullRequest = (
  selection: Selection,
  allSpecs: readonly string[],
  { always = [], beforeRelease = [] }: SpecLists
): ReadonlyMap<string, readonly string[]> => {
  const chosen = new Map<string, readonly string[]>(
    selection.kind === 'everything'
      ? allSpecs.map((spec) => [spec, selection.because])
      : selection.specs
  )
  for (const spec of expandSpecs(always, allSpecs))
    chosen.set(spec, [
      ...(chosen.get(spec) ?? []),
      'every pull request runs it',
    ])
  for (const spec of expandSpecs(beforeRelease, allSpecs)) chosen.delete(spec)
  return new Map([...chosen].sort(([a], [b]) => a.localeCompare(b)))
}
