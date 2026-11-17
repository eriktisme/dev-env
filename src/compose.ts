import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { DevEnvError } from './errors.ts'
import { LOOPBACK } from './ports.ts'

const run = promisify(execFile)

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export interface ComposeProject {
  readonly name: string
  readonly directory: string
  /** compose.yaml, then any override for the mode, in the order Compose merges them. */
  readonly files: readonly string[]
  readonly variables: Readonly<Record<string, string>>
}

interface ComposeConfig {
  readonly volumes?: Readonly<Record<string, { readonly name?: string }>>
  readonly services?: Readonly<
    Record<
      string,
      {
        readonly volumes?: readonly {
          readonly type?: string
          readonly source?: string
        }[]
        readonly healthcheck?: { readonly disable?: boolean }
        readonly ports?: readonly {
          readonly host_ip?: string
          readonly published?: string | number
        }[]
      }
    >
  >
}

interface ComposePublisher {
  readonly PublishedPort?: number
}

interface ComposeContainer {
  readonly Service: string
  readonly State: string
  readonly Publishers?: readonly ComposePublisher[]
}

export const composeFileOf = (directory: string): string =>
  join(directory, 'compose.yaml')

/*
 * A test environment's data is thrown away after every file, so a target can
 * trade durability for speed there, in compose.test.yaml, without touching the
 * dev environment it keeps between days.
 */
export const testOverrideOf = (directory: string): string =>
  join(directory, 'compose.test.yaml')

export const isDockerAvailable = async (): Promise<boolean> => {
  try {
    await run('docker', ['info'])
    return true
  } catch {
    return false
  }
}

export const assertDockerAvailable = async (): Promise<void> => {
  if (!(await isDockerAvailable())) {
    throw new DevEnvError('This target needs Docker. Start Docker and retry.')
  }
}

const compose = async (
  project: ComposeProject,
  ...args: string[]
): Promise<string> => {
  try {
    const { stdout } = await run(
      'docker',
      [
        'compose',
        '--project-name',
        project.name,
        ...project.files.flatMap((file) => ['--file', file]),
        ...args,
      ],
      {
        env: { ...process.env, ...project.variables },
        maxBuffer: MAX_OUTPUT_BYTES,
      }
    )
    return stdout
  } catch (error) {
    const { stderr } = error as { readonly stderr?: string }
    throw new DevEnvError(
      `docker compose ${args[0]} failed for ${project.name}.\n${stderr?.trim() ?? ''}`
    )
  }
}

/*
 * Compose reports a service with no healthcheck as ready once it has started,
 * and a port with no host address is reachable from the whole network.
 */
export const assertServicesAreSafe = async (
  project: ComposeProject,
  services: readonly string[]
): Promise<void> => {
  const config = JSON.parse(
    await compose(project, 'config', '--format', 'json')
  ) as ComposeConfig

  for (const service of services) {
    const definition = config.services?.[service]
    if (definition === undefined) {
      throw new DevEnvError(
        `Service "${service}" is not defined in ${composeFileOf(project.directory)}.`
      )
    }
    if (
      definition.healthcheck === undefined ||
      definition.healthcheck.disable === true
    ) {
      throw new DevEnvError(`Service "${service}" needs a healthcheck.`)
    }
    const exposed = definition.ports?.find((port) => port.host_ip !== LOOPBACK)
    if (exposed !== undefined) {
      throw new DevEnvError(
        `Service "${service}" must publish its port on ${LOOPBACK}.`
      )
    }
  }
}

export const composeUp = async (
  project: ComposeProject,
  services: readonly string[],
  timeoutMs: number
): Promise<void> => {
  try {
    await compose(
      project,
      'up',
      '--detach',
      '--wait',
      '--remove-orphans',
      '--wait-timeout',
      String(Math.ceil(timeoutMs / 1000)),
      ...services
    )
  } catch (error) {
    const logs = await compose(
      project,
      'logs',
      '--no-color',
      '--tail',
      '20',
      ...services
    ).catch(() => '')
    const reason = error instanceof Error ? error.message : String(error)
    throw new DevEnvError(
      `Services did not become healthy: ${services.join(', ')}.\n${reason}\n${logs}`
    )
  }
}

export const composeStop = async (
  project: ComposeProject,
  services: readonly string[] = []
): Promise<void> => {
  await compose(project, 'stop', ...services)
}

/* Scoped to this project, so it cannot reach another environment's volumes. */
export const composeDownWithVolumes = async (
  project: ComposeProject
): Promise<void> => {
  await compose(project, 'down', '--volumes', '--remove-orphans')
}

/*
 * Only the named services, with every volume they mount, so their next start
 * has no data. `rm --volumes` takes only anonymous volumes, so the named ones
 * are removed by the names Compose gave them in this project.
 */
export const composeRemoveWithVolumes = async (
  project: ComposeProject,
  services: readonly string[]
): Promise<void> => {
  const config = JSON.parse(
    await compose(project, 'config', '--format', 'json')
  ) as ComposeConfig
  const volumes = services.flatMap((service) =>
    (config.services?.[service]?.volumes ?? []).flatMap((mount) =>
      mount.type === 'volume' && mount.source !== undefined
        ? [config.volumes?.[mount.source]?.name ?? mount.source]
        : []
    )
  )
  await compose(project, 'rm', '--stop', '--force', '--volumes', ...services)
  if (volumes.length === 0) return
  try {
    await run('docker', ['volume', 'rm', '--force', ...new Set(volumes)])
  } catch (error) {
    const { stderr } = error as { readonly stderr?: string }
    throw new DevEnvError(
      `Could not remove the volumes of ${services.join(', ')} in ${project.name}.\n${stderr?.trim() ?? ''}`
    )
  }
}

/** Running services and the host port each one publishes. */
export const runningServicesOf = async (
  project: ComposeProject
): Promise<ReadonlyMap<string, number | undefined>> => {
  const output = await compose(project, 'ps', '--format', 'json')
  const containers = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ComposeContainer)
    .filter((container) => container.State === 'running')

  return new Map(
    containers.map((container) => [
      container.Service,
      container.Publishers?.find((publisher) =>
        Boolean(publisher.PublishedPort)
      )?.PublishedPort,
    ])
  )
}
