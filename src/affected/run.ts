import { execFileSync, spawnSync } from 'node:child_process'
import { relative } from 'node:path'
import { stdout } from 'node:process'

import { resolveCheckout } from '../checkout.ts'
import { DevEnvError } from '../errors.ts'
import { loadTarget } from '../manifest.ts'
import { commandOf, packageManagerOf } from '../workspace.ts'
import { graphOf, specsIn } from './graph.ts'
import { layoutOf } from './layout.ts'
import { forPullRequest, selectSpecs } from './select.ts'

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

/**
 * Runs the integration specs of `name` that the checkout's changes since
 * `base` reach, saying which it chose and why, and returns Vitest's exit code.
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
  const here = relative(root, target.directory)
  const paths = changed.map((path) =>
    path.startsWith(`${here}/`) ? path.slice(here.length + 1) : `/${path}`
  )

  const print = (line: string) => stdout.write(`${line}\n`)
  const layout = layoutOf(target.directory, root, target.manifest)
  const selection = selectSpecs(graphOf(layout), paths)
  print(`${name}: ${paths.length} paths changed since ${since.slice(0, 12)}.`)
  if (selection.kind === 'everything') {
    print('Every integration spec is affected, because:')
    for (const reason of selection.because) print(`  ${reason}`)
  }
  const lists = target.manifest.specs ?? {}
  const chosen = forPullRequest(selection, specsIn(layout), lists)
  const left = (lists.beforeRelease ?? []).filter(
    (spec) => selection.kind === 'everything' || selection.specs.has(spec)
  )
  if (left.length > 0)
    print(`Left to the full suite before a release: ${left.join(', ')}.`)
  if (chosen.size === 0) {
    print('No change reaches an integration spec, so none runs.')
    return 0
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
  const files = [...chosen.keys()]
  if (list) return 0

  const [command = 'npm', ...args] = commandOf(
    packageManagerOf(root),
    'vitest',
    ['run', '--config', 'vitest.integration.ts', ...files]
  )
  const run = spawnSync(command, args, {
    cwd: target.directory,
    stdio: 'inherit',
  })
  return run.status ?? 1
}
