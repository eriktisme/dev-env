import { execFileSync, spawnSync } from 'node:child_process'
import { relative } from 'node:path'
import { stdout } from 'node:process'

import { resolveCheckout } from '../checkout.ts'
import { DevEnvError } from '../errors.ts'
import { loadTarget } from '../manifest.ts'
import { commandOf, packageManagerOf, scriptCommandOf } from '../workspace.ts'
import { graphOf, specsIn } from './graph.ts'
import { consumerLayoutsOf, layoutOf } from './layout.ts'
import type { Layout } from './graph.ts'
import {
  expandSpecs,
  forPullRequest,
  selectSpecs,
  type SpecLists,
} from './select.ts'

const git = (cwd: string, ...args: string[]): string[] =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .filter((line) => line !== '')

const gitOrNothing = (cwd: string, ...args: string[]): string | undefined => {
  try {
    return git(cwd, ...args)[0]
  } catch {
    return undefined
  }
}

/*
 * The remote's default branch, as `origin/HEAD` names it, or else
 * `origin/main` or `origin/master`, whichever exists.
 */
const defaultBranchOf = (root: string): string => {
  const head = gitOrNothing(
    root,
    'rev-parse',
    '--abbrev-ref',
    '--verify',
    '--quiet',
    'origin/HEAD'
  )
  if (head !== undefined && head !== 'origin/HEAD') return head
  const found = ['origin/main', 'origin/master'].find(
    (branch) =>
      gitOrNothing(root, 'rev-parse', '--verify', '--quiet', branch) !==
      undefined
  )
  if (found === undefined)
    throw new DevEnvError(
      'No origin/HEAD, origin/main or origin/master to compare with. Pass the base with --base <ref>.'
    )
  return found
}

interface Group {
  readonly name: string
  readonly directory: string
  readonly layout: Layout
  readonly lists: SpecLists
  /** The command, from the repository's package manager, that runs `files` in the group's directory. */
  readonly command: (files: readonly string[]) => readonly string[]
}

/**
 * Runs the integration specs of `name`, and of its consumers, that the
 * checkout's changes since `base` reach, saying which it chose and why. Each
 * package runs in a group of its own, the target's first and then each
 * consumer's, and every group runs even after one fails. It returns 0 when
 * every group passed, and else the first exit code that was not.
 * Without `base`, it compares with where the checkout left the remote's
 * default branch. With `list`, it only says which it would run.
 */
export const runAffected = async (
  cwd: string,
  name: string,
  {
    base,
    list = false,
  }: { readonly base?: string; readonly list?: boolean } = {}
): Promise<number> => {
  const { root } = await resolveCheckout(cwd)
  const target = await loadTarget(root, name)
  const since =
    base ?? git(root, 'merge-base', 'HEAD', defaultBranchOf(root))[0] ?? ''

  // Committed and uncommitted changes since the base, and files git does not track yet.
  const changed = [
    ...new Set([
      ...git(root, 'diff', '--name-only', '--no-renames', since),
      ...git(root, 'ls-files', '--others', '--exclude-standard'),
    ]),
  ]

  const packageManager = packageManagerOf(root)
  const consumers = consumerLayoutsOf(target.directory, root, target.manifest)
  const groups: readonly Group[] = [
    {
      name,
      directory: target.directory,
      layout: layoutOf(target.directory, root, target.manifest),
      lists: target.manifest.specs ?? {},
      command: (files) =>
        commandOf(packageManager, 'vitest', [
          'run',
          '--config',
          'vitest.integration.ts',
          ...files,
        ]),
    },
    ...consumers.map((consumer): Group => ({
      name: consumer.name,
      directory: consumer.directory,
      layout: consumer.layout,
      lists: consumer.specs,
      command: (files) =>
        scriptCommandOf(packageManager, consumer.script, files),
    })),
  ]

  const print = (line: string) => stdout.write(`${line}\n`)
  print(`${name}: ${changed.length} paths changed since ${since.slice(0, 12)}.`)
  const exits: { readonly name: string; readonly code: number | undefined }[] =
    []
  for (const group of groups) {
    if (consumers.length > 0)
      print(`${group.name}, in ${relative(root, group.directory)}:`)
    const here = relative(root, group.directory)
    const paths = changed.map((path) =>
      path.startsWith(`${here}/`) ? path.slice(here.length + 1) : `/${path}`
    )
    const selection = selectSpecs(graphOf(group.layout), paths)
    if (selection.kind === 'everything') {
      print('Every integration spec is affected, because:')
      for (const reason of selection.because) print(`  ${reason}`)
    }
    const allSpecs = specsIn(group.layout)
    const chosen = forPullRequest(selection, allSpecs, group.lists)
    const left = expandSpecs(group.lists.beforeRelease ?? [], allSpecs).filter(
      (spec) => selection.kind === 'everything' || selection.specs.has(spec)
    )
    if (left.length > 0)
      print(`Left to the full suite before a release: ${left.join(', ')}.`)
    if (chosen.size === 0) {
      print('No change reaches an integration spec, so none runs.')
      exits.push({ name: group.name, code: undefined })
      continue
    }
    print(`Running ${chosen.size} integration specs:`)
    // With every spec affected, the reasons above are every spec's, so each lists only its own.
    const own = (reasons: readonly string[]) =>
      selection.kind === 'everything'
        ? reasons.filter((reason) => !selection.because.includes(reason))
        : reasons
    for (const [spec, reasons] of chosen) {
      print(`  ${spec}`)
      for (const reason of own(reasons)) print(`    ${reason}`)
    }
    if (list) continue

    const [command = 'npm', ...args] = group.command([...chosen.keys()])
    const run = spawnSync(command, args, {
      cwd: group.directory,
      stdio: 'inherit',
    })
    exits.push({ name: group.name, code: run.status ?? 1 })
  }

  if (consumers.length > 0 && !list)
    print(
      `Exit codes: ${exits.map(({ name: group, code }) => `${group} ${code ?? 'not run'}`).join(', ')}.`
    )
  return exits.find(({ code }) => code !== undefined && code !== 0)?.code ?? 0
}
