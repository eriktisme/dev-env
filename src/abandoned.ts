import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'

import { composeProjectOf, environmentIdOf } from './checkout.ts'

const run = promisify(execFile)

const PROJECT_LABEL = 'com.docker.compose.project'

const escaped = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * A project dev-env made is named for its checkout, by the checkout's
 * directory name and id, the hash of its root. The checkout is one of the
 * directories above the working directory Compose recorded, the target's, at
 * whatever depth its workspace was. A name no such directory gives is someone
 * else's project, or a shared one, and is never touched.
 */
export const isAbandonedProject = (
  project: string,
  workingDirectory: string,
  exists: (path: string) => boolean = existsSync
): boolean => {
  if (exists(workingDirectory)) return false
  const target = basename(workingDirectory)
  for (
    let root = dirname(workingDirectory);
    root !== dirname(root);
    root = dirname(root)
  ) {
    const name = composeProjectOf(
      { root, id: environmentIdOf(root) },
      target,
      'dev'
    )
    if (new RegExp(`^${escaped(name)}(-test(-\\d+)?)?$`).test(project))
      return true
  }
  return false
}

const lines = async (args: readonly string[]): Promise<string[]> => {
  const { stdout } = await run('docker', [...args])
  return stdout.split('\n').filter((line) => line !== '')
}

const removeProject = async (project: string): Promise<void> => {
  const filter = ['--filter', `label=${PROJECT_LABEL}=${project}`]
  const containers = await lines(['ps', '--all', '--quiet', ...filter])
  if (containers.length > 0)
    await run('docker', ['rm', '--force', '--volumes', ...containers])
  const networks = await lines(['network', 'ls', '--quiet', ...filter])
  if (networks.length > 0) await run('docker', ['network', 'rm', ...networks])
  const volumes = await lines(['volume', 'ls', '--quiet', ...filter])
  if (volumes.length > 0)
    await run('docker', ['volume', 'rm', '--force', ...volumes])
}

let swept: Promise<void> | undefined

/*
 * A worktree deleted without `env:reset` leaves its containers, volumes and
 * network behind, and Docker runs out of network addresses at about thirty.
 * Its compose file is gone with it, so the project is removed by its labels.
 * Once per process; a removal another process already made is not an error.
 */
export const removeAbandonedProjects = (): Promise<void> => {
  swept ??= (async () => {
    const recorded = await lines([
      'ps',
      '--all',
      '--format',
      `{{.Label "${PROJECT_LABEL}"}}\t{{.Label "${PROJECT_LABEL}.working_dir"}}`,
    ])
    const projects = new Map(
      recorded.map((line) => line.split('\t') as [string, string])
    )
    for (const [project, workingDirectory] of projects)
      if (
        project &&
        workingDirectory &&
        isAbandonedProject(project, workingDirectory)
      )
        await removeProject(project).catch(() => undefined)
  })()
  return swept
}
