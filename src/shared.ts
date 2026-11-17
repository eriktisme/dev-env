import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { ComposeProject } from './compose.ts'
import {
  assertServicesAreSafe,
  composeFileOf,
  composeUp,
  runningServicesOf,
} from './compose.ts'
import { machineDirectoryOf, machineIdOf } from './machine.ts'
import type { Target } from './manifest.ts'
import { portVariablesOf } from './manifest.ts'
import { choosePort, isPortInUse, preferredPortOf, withLock } from './ports.ts'

const DEFAULT_TIMEOUT_MS = 120_000
// A waiter queues behind a start that can take as long as the slowest service.
const LOCK_MARGIN_MS = 60_000

interface SharedState {
  readonly ports: Readonly<Record<string, number>>
}

export const sharedServicesOf = (target: Target): readonly string[] =>
  Object.entries(target.manifest.services)
    .filter(([, service]) => service.kind === 'compose' && service.shared)
    .map(([name]) => name)

const sharedDirectory = (): string => {
  const directory = join(machineDirectoryOf(), 'shared')
  mkdirSync(directory, { recursive: true })
  return directory
}

/* Not tied to a checkout: every checkout of the target on the machine uses it. */
const projectNameOf = (target: Target): string =>
  `dev-env-shared-${machineIdOf(machineDirectoryOf())}-${target.name}`

const statePathOf = (target: Target): string =>
  join(sharedDirectory(), `${projectNameOf(target)}.json`)

const readPorts = (path: string): Readonly<Record<string, number>> =>
  existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as SharedState).ports
    : {}

export const sharedPortsOf = (
  target: Target
): Readonly<Record<string, number>> => readPorts(statePathOf(target))

/** Every port a shared service on this machine holds, which no environment may take. */
export const portsSharedOnMachine = (): ReadonlySet<number> =>
  new Set(
    readdirSync(sharedDirectory())
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) =>
        Object.values(readPorts(join(sharedDirectory(), file)))
      )
  )

/*
 * The base compose file only: a test override trades durability for speed in
 * one environment, and this one serves them all.
 */
export const sharedProjectOf = (
  target: Target,
  ports: Readonly<Record<string, number>> = sharedPortsOf(target)
): ComposeProject => ({
  name: projectNameOf(target),
  directory: target.directory,
  files: [composeFileOf(target.directory)],
  variables: portVariablesOf({
    ...Object.fromEntries(
      Object.keys(target.manifest.services).map((service) => [service, 0])
    ),
    ...ports,
  }),
})

export const runningSharedServicesOf = async (
  target: Target
): Promise<ReadonlyMap<string, number | undefined>> =>
  sharedServicesOf(target).length === 0
    ? new Map()
    : runningServicesOf(sharedProjectOf(target))

/*
 * Starts the target's shared services unless they already run, and returns
 * their ports. A running stack is never recreated, even when this checkout's
 * compose file defines it differently, because other runs are using it; the
 * first definition stays until someone removes the project.
 */
export const ensureSharedServices = async (
  target: Target,
  claimed: ReadonlySet<number>
): Promise<Readonly<Record<string, number>>> => {
  const services = sharedServicesOf(target)
  if (services.length === 0) return {}
  const timeoutMs = Math.max(
    ...services.map(
      (service) =>
        target.manifest.services[service]?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
  )

  return withLock(
    join(machineDirectoryOf(), 'shared.lock'),
    timeoutMs + LOCK_MARGIN_MS,
    async () => {
      const recorded = sharedPortsOf(target)
      const running =
        Object.keys(recorded).length > 0
          ? await runningServicesOf(sharedProjectOf(target, recorded))
          : new Map<string, number | undefined>()
      if (
        services.every(
          (service) =>
            recorded[service] !== undefined &&
            running.get(service) === recorded[service]
        )
      )
        return recorded

      const ports: Record<string, number> = {}
      for (const service of services) {
        const previous = recorded[service]
        ports[service] = await choosePort(
          previous ??
            preferredPortOf(`shared:${projectNameOf(target)}:${service}`),
          async (candidate) =>
            Object.values(ports).includes(candidate) ||
            (candidate !== previous && claimed.has(candidate)) ||
            ((await isPortInUse(candidate)) &&
              running.get(service) !== candidate)
        )
      }
      const path = statePathOf(target)
      writeFileSync(`${path}.tmp`, JSON.stringify({ ports }, null, 2))
      renameSync(`${path}.tmp`, path)

      const project = sharedProjectOf(target, ports)
      await assertServicesAreSafe(project, services)
      await composeUp(project, services, timeoutMs)
      return ports
    }
  )
}
