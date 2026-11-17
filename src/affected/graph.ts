/*
 * What each integration spec of a target reaches, read from the code rather
 * than kept by hand: the files a spec imports, the processes its
 * `startTestEnvironment` call leaves in, and the files under each process's
 * `sources` with what they import. A new spec or process needs no edit here.
 *
 * Bindings between processes add nothing: in a test environment a process
 * answers only when the spec starts it.
 *
 * Paths are relative to the target, and a path that starts with `/` is
 * relative to the repository.
 */
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { type Cache, createPathsMatcher, getTsconfig } from 'get-tsconfig'
import { parseSync } from 'oxc-parser'

export interface Layout {
  /** The target's directory. */
  readonly target: string
  /** The repository's directory. */
  readonly repository: string
  /** Each process the target can start, by the name a spec's `without` uses, with its `sources`. */
  readonly processes: ReadonlyMap<string, readonly string[]>
  /** Each workspace package of the repository by its name, with its directory, as `/libs/ui/`. */
  readonly packages: ReadonlyMap<string, string>
  /** Globs for paths every spec is built from without importing them, such as the lockfile. */
  readonly shared: readonly string[]
}

/** Where a path reaches a spec from: the spec's own imports, or a process it starts. */
export type Route =
  | { readonly kind: 'imports' }
  | { readonly kind: 'process'; readonly process: string }

export interface Reach {
  /** Every file the spec reaches, with the route it reaches it by. */
  readonly files: ReadonlyMap<string, Route>
  /** Directories the spec reaches as a whole, such as a process's sources or a package. */
  readonly directories: ReadonlyMap<string, Route>
}

/** Files that never run in a test environment, even inside a process's sources. */
export const NOT_RUNTIME: readonly RegExp[] = [
  /\.md$/,
  /\.spec\.tsx?$/,
  /\.stories\.tsx$/,
  /(^|\/)\.storybook\//,
  /(^|\/)\.oxlintrc\.json$/,
]

export const isRuntime = (path: string): boolean =>
  !NOT_RUNTIME.some((pattern) => pattern.test(path))

interface Node {
  readonly type: string
  readonly [key: string]: unknown
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string'

/** Every node under `root`, depth first. */
function* nodesOf(root: unknown): Generator<Node> {
  if (Array.isArray(root)) {
    for (const item of root) yield* nodesOf(item)
    return
  }
  if (!isNode(root)) return
  yield root
  for (const value of Object.values(root)) yield* nodesOf(value)
}

const keyOf = (property: Node): string | undefined => {
  const key = property.key
  if (!isNode(key)) return undefined
  if (key.type === 'Identifier') return key.name as string
  return typeof key.value === 'string' ? key.value : undefined
}

const stringOf = (node: unknown): string | undefined =>
  isNode(node) && node.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : undefined

const parse = (file: string, text: string) => {
  const result = parseSync(file, text)
  if (result.errors.length > 0)
    throw new Error(
      `${file} does not parse: ${result.errors.map((error) => error.message).join('; ')}`
    )
  return result
}

export const pathIn = (layout: Layout, absolute: string): string => {
  const inside = relative(layout.target, absolute)
  return inside.startsWith('..')
    ? `/${relative(layout.repository, absolute)}`
    : inside
}

const absoluteOf = (layout: Layout, path: string): string =>
  path.startsWith('/')
    ? join(layout.repository, path)
    : join(layout.target, path)

const fileAt = (base: string): string | undefined =>
  ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
    .map((suffix) => base + suffix)
    .find((path) => existsSync(path) && statSync(path).isFile())

const requestsOf = (file: string): string[] => {
  const text = readFileSync(file, 'utf8')
  const { module } = parse(file, text)
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) =>
        exported.moduleRequest === null ? [] : [exported.moduleRequest.value]
      )
    ),
    ...module.dynamicImports.map(({ moduleRequest }) =>
      text.slice(moduleRequest.start + 1, moduleRequest.end - 1)
    ),
  ]
}

interface Imports {
  readonly files: ReadonlySet<string>
  readonly packages: ReadonlySet<string>
}

/*
 * Where a request may point by the `paths` of the tsconfig.json nearest the
 * importing file, such as `@/src/db/connection`, the way TypeScript and Vite
 * read them.
 */
const aliasesNear = (): ((file: string, request: string) => string[]) => {
  const cache: Cache = new Map()
  const byDirectory = new Map<string, ((request: string) => string[]) | null>()
  return (file, request) => {
    const directory = dirname(file)
    if (!byDirectory.has(directory)) {
      const tsconfig = getTsconfig(directory, 'tsconfig.json', cache)
      byDirectory.set(
        directory,
        tsconfig === null ? null : createPathsMatcher(tsconfig)
      )
    }
    return byDirectory.get(directory)?.(request) ?? []
  }
}

/** The package a bare request names, as `@acme/ui` for `@acme/ui/button`. */
const packageNameOf = (request: string): string =>
  request
    .split('/')
    .slice(0, request.startsWith('@') ? 2 : 1)
    .join('/')

/*
 * Every file the given files import, following relative and aliased imports,
 * and the repository's workspace packages they import, each as its directory.
 */
const importedFrom = (layout: Layout, starts: readonly string[]): Imports => {
  const aliased = aliasesNear()
  const seen = new Set<string>()
  const files = new Set<string>()
  const packages = new Set<string>()
  const queue = [...starts]
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue
    seen.add(file)
    files.add(pathIn(layout, file))
    // A JSON or CSS file is reached, but imports nothing itself.
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    for (const imported of requestsOf(file)) {
      // Vite's queries, such as ?raw, ask for the same file in another form.
      const request = imported.replace(/\?.*$/, '')
      const workspace = layout.packages.get(packageNameOf(request))
      if (workspace !== undefined) packages.add(workspace)
      const candidates = request.startsWith('.')
        ? [resolve(dirname(file), request)]
        : aliased(file, request)
      const target = candidates.map(fileAt).find((path) => path !== undefined)
      if (target !== undefined) queue.push(target)
    }
  }
  return { files, packages }
}

/**
 * The processes a spec starts: every process of the target, less the ones its
 * one `startTestEnvironment` call leaves out. A spec that does not call it
 * starts none. The list must be written out, so it can be read without
 * running the spec.
 */
export const startedBy = (layout: Layout, spec: string): string[] => {
  const file = absoluteOf(layout, spec)
  const { program } = parse(file, readFileSync(file, 'utf8'))
  const calls = [...nodesOf(program)].filter(
    (node) =>
      node.type === 'CallExpression' &&
      isNode(node.callee) &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'startTestEnvironment'
  )
  if (calls.length === 0) return []
  if (calls.length > 1)
    throw new Error(
      `${spec} calls startTestEnvironment ${calls.length} times; the selection reads one call.`
    )
  const [, options] = (calls[0]?.arguments ?? []) as unknown[]
  const all = [...layout.processes.keys()]
  if (options === undefined) return all
  const without = isNode(options)
    ? (options.properties as Node[] | undefined)?.find(
        (property) => keyOf(property) === 'without'
      )
    : undefined
  if (
    isNode(options) &&
    options.type === 'ObjectExpression' &&
    without === undefined
  )
    return all
  const list = without?.value
  const names =
    isNode(list) && list.type === 'ArrayExpression'
      ? (list.elements as unknown[]).map(stringOf)
      : undefined
  if (names === undefined || names.some((name) => name === undefined))
    throw new Error(
      `${spec} passes startTestEnvironment a \`without\` that is not a written-out list of names, so the selection cannot read which processes it starts.`
    )
  const unknown = names.filter((name) => !all.includes(name ?? ''))
  if (unknown.length > 0)
    throw new Error(
      `${spec} leaves out ${unknown.join(', ')}, which its target's manifest does not start.`
    )
  return all.filter((name) => !names.includes(name))
}

export interface Graph {
  readonly specs: ReadonlyMap<string, Reach>
  /** The layout's shared globs, a change to any of which reaches every spec. */
  readonly shared: readonly string[]
}

export const specsIn = (layout: Layout): string[] =>
  globSync('**/*.integration.spec.ts', {
    cwd: layout.target,
    exclude: (path) => /(^|\/)node_modules(\/|$)/.test(path),
  }).sort()

export const graphOf = (layout: Layout): Graph => {
  const sourcesImports = new Map<string, Imports>()
  const importsUnder = (source: string): Imports => {
    const known = sourcesImports.get(source)
    if (known !== undefined) return known
    const files = globSync(`${source}/**/*.{ts,tsx,js,mjs}`, {
      cwd: layout.target,
      exclude: (path) => /(^|\/)node_modules(\/|$)/.test(path),
    })
      .filter(isRuntime)
      .map((path) => join(layout.target, path))
    const found = importedFrom(layout, files)
    sourcesImports.set(source, found)
    return found
  }

  const specs = new Map<string, Reach>()
  for (const spec of specsIn(layout)) {
    const files = new Map<string, Route>()
    const directories = new Map<string, Route>()
    const own = importedFrom(layout, [absoluteOf(layout, spec)])
    for (const file of own.files) files.set(file, { kind: 'imports' })
    for (const directory of own.packages)
      directories.set(directory, { kind: 'imports' })
    for (const started of startedBy(layout, spec)) {
      const route: Route = { kind: 'process', process: started }
      for (const source of layout.processes.get(started) ?? []) {
        const directory = `${source.replace(/\/$/, '')}/`
        if (!directories.has(directory)) directories.set(directory, route)
        const reached = importsUnder(source)
        for (const file of reached.files)
          if (!files.has(file)) files.set(file, route)
        for (const pkg of reached.packages)
          if (!directories.has(pkg)) directories.set(pkg, route)
      }
    }
    specs.set(spec, { files, directories })
  }
  return { specs, shared: layout.shared }
}
