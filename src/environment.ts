import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { removeAbandonedProjects } from './abandoned.ts'
import type { Checkout, Mode } from './checkout.ts'
import {
  checkoutRootsOf,
  composeProjectOf,
  environmentIdOf,
  environmentKeyOf,
  isTestMode,
  resolveCheckout,
} from './checkout.ts'
import type { ComposeProject } from './compose.ts'
import {
  assertDockerAvailable,
  assertServicesAreSafe,
  composeDownWithVolumes,
  composeFileOf,
  composeRemoveWithVolumes,
  composeStop,
  composeUp,
  isDockerAvailable,
  runningServicesOf,
  testOverrideOf,
} from './compose.ts'
import { DevEnvError } from './errors.ts'
import type {
  CommandContext,
  ProcessService,
  Service,
  Target,
  WorkerService,
} from './manifest.ts'
import {
  availableTargets,
  loadTarget,
  portVariablesOf,
  testSettingsOf,
} from './manifest.ts'
import {
  choosePort,
  isPortInUse,
  LOOPBACK,
  preferredPortOf,
  withAllocationLock,
} from './ports.ts'
import {
  isLeaderLive,
  isRecordedProcessLive,
  startProcess,
  stopProcess,
  tailOf,
} from './processes.ts'
import { waitUntilAnswering } from './readiness.ts'
import {
  ensureSharedServices,
  portsSharedOnMachine,
  runningSharedServicesOf,
  sharedServicesOf,
} from './shared.ts'
import type { EnvironmentState } from './state.ts'
import {
  dataDirectoryOf,
  environmentDirectoryOf,
  readAllStates,
  readState,
  removeState,
  writeState,
} from './state.ts'
import {
  prepareWorkers,
  WORKER_ENVIRONMENT,
  workerCommandOf,
} from './worker.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const LOG_LINES_ON_FAILURE = 20
const UNALLOCATED_PORT = 0

export interface ServiceInfo {
  readonly kind: 'process' | 'worker' | 'compose'
  readonly running: boolean
  readonly port: number
  readonly address: string
  readonly url?: string
}

export interface EnvironmentInfo {
  readonly target: string
  readonly mode: Mode
  /** Unique on the machine, to tell this environment's data apart in a shared service. */
  readonly name: string
  readonly composeProject?: string
  readonly services: Readonly<Record<string, ServiceInfo>>
}

export interface CheckoutInfo {
  readonly environmentId: string
  readonly checkout: string
  readonly available: readonly string[]
  readonly environments: readonly EnvironmentInfo[]
}

/** The environment's own containers, leaving out those shared on the machine. */
const composeServicesOf = (target: Target): readonly string[] =>
  Object.entries(target.manifest.services)
    .filter(([, service]) => service.kind === 'compose' && !service.shared)
    .map(([name]) => name)

const needsDocker = (target: Target): boolean =>
  Object.values(target.manifest.services).some(
    (service) => service.kind === 'compose'
  )

const processServicesOf = (
  target: Target
): readonly (readonly [string, ProcessService | WorkerService])[] =>
  Object.entries(target.manifest.services).flatMap(([name, service]) =>
    service.kind === 'compose' ? [] : [[name, service] as const]
  )

/*
 * Compose interpolates the whole file for every command, so one service added
 * to the manifest since the ports were recorded would fail even a `ps`. The
 * placeholder is never published, because allocation runs before any `up`.
 */
const composeProjectFor = (
  checkout: Checkout,
  target: Target,
  mode: Mode,
  ports: Readonly<Record<string, number>>
): ComposeProject => ({
  name: composeProjectOf(checkout, target.name, mode),
  directory: target.directory,
  files: [
    composeFileOf(target.directory),
    ...(isTestMode(mode) && existsSync(testOverrideOf(target.directory))
      ? [testOverrideOf(target.directory)]
      : []),
  ],
  variables: portVariablesOf({
    ...Object.fromEntries(
      Object.keys(target.manifest.services).map((service) => [
        service,
        UNALLOCATED_PORT,
      ])
    ),
    ...ports,
  }),
})

const composeTimeoutOf = (
  target: Target,
  services: readonly string[]
): number =>
  Math.max(
    ...services.map(
      (service) =>
        target.manifest.services[service]?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
  )

const usesCompose = (target: Target): boolean =>
  composeServicesOf(target).length > 0

const portsClaimedElsewhere = async (
  checkout: Checkout,
  ownKey: string
): Promise<ReadonlySet<number>> => {
  const roots = await checkoutRootsOf(checkout)
  const others = roots.flatMap((root) =>
    readAllStates(root).filter(
      (state) =>
        root !== checkout.root ||
        environmentKeyOf(state.target, state.mode) !== ownKey
    )
  )

  return new Set(others.flatMap((state) => Object.values(state.ports)))
}

/*
 * A probe only says what is listening right now, and a sibling's container
 * between a remove and a create looks free. The recorded claims, read and
 * written under the lock, are what keep two environments apart.
 */
const allocatePorts = (
  checkout: Checkout,
  target: Target,
  mode: Mode,
  sharedPorts: Readonly<Record<string, number>>
): Promise<EnvironmentState> =>
  withAllocationLock(checkout.gitCommonDirectory, async () => {
    const key = environmentKeyOf(target.name, mode)
    const previous = readState(checkout.root, target.name, mode)
    const claimed = new Set([
      ...(await portsClaimedElsewhere(checkout, key)),
      ...portsSharedOnMachine(),
    ])
    const provisional = composeProjectFor(checkout, target, mode, {
      ...previous?.ports,
    })
    const running =
      usesCompose(target) && previous !== undefined
        ? await runningServicesOf(provisional)
        : new Map<string, number | undefined>()

    const ports: Record<string, number> = { ...sharedPorts }
    for (const [service, definition] of Object.entries(
      target.manifest.services
    )) {
      if (service in sharedPorts) continue
      const recorded = previous?.processes[service]
      const isOurs = async (port: number): Promise<boolean> => {
        if (previous?.ports[service] !== port) return false
        if (definition.kind === 'compose') return running.get(service) === port
        return recorded !== undefined && (await isRecordedProcessLive(recorded))
      }
      const port = await choosePort(
        previous?.ports[service] ??
          preferredPortOf(`${checkout.id}:${key}:${service}`),
        async (candidate) =>
          claimed.has(candidate) ||
          ((await isPortInUse(candidate)) && !(await isOurs(candidate)))
      )
      ports[service] = port
      claimed.add(port)
    }

    const state: EnvironmentState = {
      environmentId: checkout.id,
      target: target.name,
      mode,
      ports,
      processes: previous?.processes ?? {},
    }
    writeState(checkout.root, state)
    return state
  })

const waitForProcessReady = async (
  name: string,
  service: ProcessService | WorkerService,
  port: number,
  isLive: () => Promise<boolean>,
  logPath: string
): Promise<void> => {
  const url = `http://${LOOPBACK}:${port}${service.readinessPath}`
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const failure = (reason: string): DevEnvError =>
    new DevEnvError(
      `Service "${name}" ${reason}.\n${tailOf(logPath, LOG_LINES_ON_FAILURE)}`
    )

  const readiness = await waitUntilAnswering({ url, timeoutMs, isLive })
  if (readiness === 'exited') throw failure('exited before it was ready')
  if (readiness === 'timed out')
    throw failure(`did not answer ${url} within ${timeoutMs} ms`)
}

/*
 * One at a time, each ready before the next starts: the processes of a target
 * share one local state directory, and Wrangler runtimes that open it at the
 * same moment fail with a locked database.
 */
const startProcesses = async (
  checkout: Checkout,
  target: Target,
  initial: EnvironmentState,
  services = processServicesOf(target)
): Promise<EnvironmentState> => {
  let state = initial

  for (const [name, service] of services) {
    const recorded = state.processes[name]
    if (recorded !== undefined) {
      if (await isLeaderLive(recorded)) continue
      // What survived its leader may no longer be serving, so it is replaced.
      await stopProcess(recorded)
    }

    const port = state.ports[name]
    if (port === undefined) {
      throw new DevEnvError(`Service "${name}" has no allocated port.`)
    }
    const logPath = join(
      environmentDirectoryOf(checkout.root, target.name, state.mode),
      `${name}.log`
    )
    const dataDirectory = dataDirectoryOf(
      checkout.root,
      target.name,
      state.mode
    )
    mkdirSync(dataDirectory, { recursive: true })
    const context: CommandContext = {
      environmentName: composeProjectOf(checkout, target.name, state.mode),
      settings: state.settings ?? {},
      port,
      ports: state.ports,
      dataDirectory,
    }
    const started = await startProcess({
      command:
        service.kind === 'worker'
          ? await workerCommandFor(checkout, target, service, context, state)
          : service.command(context),
      directory: target.directory,
      environment: {
        ...portVariablesOf(state.ports),
        PORT: String(port),
        ...(service.kind === 'worker' ? WORKER_ENVIRONMENT : {}),
      },
      logPath,
    })
    state = {
      ...state,
      processes: { ...state.processes, [name]: started },
    }
    writeState(checkout.root, state)

    try {
      await waitForProcessReady(
        name,
        service,
        port,
        () => isLeaderLive(started),
        logPath
      )
    } catch (error) {
      await stopProcess(started)
      throw error
    }
  }

  return state
}

/*
 * Another target's service, as this checkout runs it in the same mode. It
 * is asked for by the target's own name, so a Worker is pointed at the
 * database the checkout started and never at a guessed port.
 */
const addressOfRunning = async (
  checkout: Checkout,
  mode: Mode,
  targetName: string,
  service: string
): Promise<string> => {
  const info = await describe(
    checkout,
    await loadTarget(checkout.root, targetName),
    mode
  )
  const found = info.services[service]
  if (found === undefined || !found.running)
    throw new DevEnvError(
      `Service "${service}" of target "${targetName}" is not running. Start it first: \`dev-env start ${targetName}${isTestMode(mode) ? ' --test' : ''}\`.`
    )
  return found.address
}

const workerCommandFor = async (
  checkout: Checkout,
  target: Target,
  service: WorkerService,
  context: CommandContext,
  state: EnvironmentState
): Promise<readonly string[]> => {
  const workDirectory = join(context.dataDirectory, 'workers')
  const workers = await prepareWorkers({
    service,
    directory: target.directory,
    workDirectory,
    bindings: async (worker) =>
      (await service.bindings?.({
        ...context,
        worker,
        addressOf: (other, name) =>
          addressOfRunning(checkout, state.mode, other, name),
      })) ?? {},
  })
  return workerCommandOf({
    directory: target.directory,
    port: context.port,
    persistDirectory: join(context.dataDirectory, 'state'),
    workers,
  })
}

const startSharedServices = async (
  checkout: Checkout,
  target: Target
): Promise<Readonly<Record<string, number>>> =>
  sharedServicesOf(target).length === 0
    ? {}
    : ensureSharedServices(target, await portsClaimedElsewhere(checkout, ''))

export const startTarget = async (
  cwd: string,
  targetName: string,
  mode: Mode
): Promise<EnvironmentInfo> => {
  const checkout = await resolveCheckout(cwd)
  const target = await loadTarget(checkout.root, targetName)
  const services = composeServicesOf(target)
  if (needsDocker(target)) {
    await assertDockerAvailable()
    await removeAbandonedProjects()
  }

  const state = await allocatePorts(
    checkout,
    target,
    mode,
    await startSharedServices(checkout, target)
  )

  if (services.length > 0) {
    const project = composeProjectFor(checkout, target, mode, state.ports)
    await assertServicesAreSafe(project, services)
    await composeUp(project, services, composeTimeoutOf(target, services))
  }

  const { setup, afterStart } = target.manifest
  if (setup !== undefined && !isTestMode(mode)) {
    try {
      await setup({ ports: state.ports })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DevEnvError(`Setup of "${target.name}" failed: ${reason}`)
    }
  }

  await startProcesses(checkout, target, state)

  if (afterStart !== undefined && !isTestMode(mode)) {
    try {
      await afterStart({ ports: state.ports })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DevEnvError(`After starting "${target.name}" failed: ${reason}`)
    }
  }

  return describe(checkout, target, mode)
}

/*
 * What a test file finds at its start: the containers its lane already runs,
 * recreated empty, those shared on the machine left running, and every process
 * started again on an empty data directory. A lane that is not fully running
 * is reset and started from nothing.
 */
export const startTestTarget = async (
  cwd: string,
  targetName: string,
  mode: Mode,
  {
    without = [],
    settings: asked = {},
  }: {
    readonly without?: readonly string[]
    readonly settings?: Readonly<Record<string, string>>
  } = {}
): Promise<EnvironmentInfo> => {
  const checkout = await resolveCheckout(cwd)
  const target = await loadTarget(checkout.root, targetName)
  const settings = testSettingsOf(target.manifest, asked)
  const services = composeServicesOf(target)
  const processes = processServicesOf(target).filter(
    ([name]) => !without.includes(name)
  )
  if (needsDocker(target)) await removeAbandonedProjects()
  const sharedPorts = await startSharedServices(checkout, target)
  const previous = readState(checkout.root, targetName, mode)
  const running =
    previous !== undefined && services.length > 0
      ? await runningServicesOf(
          composeProjectFor(checkout, target, mode, previous.ports)
        )
      : new Map<string, number | undefined>()
  const isWarm =
    previous !== undefined &&
    services.every(
      (service) => running.get(service) === previous.ports[service]
    )

  if (!isWarm) {
    await resetTarget(cwd, targetName, mode)
    const state: EnvironmentState = {
      ...(await allocatePorts(checkout, target, mode, sharedPorts)),
      settings,
    }
    writeState(checkout.root, state)
    if (services.length > 0) {
      const project = composeProjectFor(checkout, target, mode, state.ports)
      await assertServicesAreSafe(project, services)
      await composeUp(project, services, composeTimeoutOf(target, services))
    }
    await startProcesses(checkout, target, state, processes)
    return describe(checkout, target, mode)
  }

  await stopProcesses(checkout, previous)
  rmSync(dataDirectoryOf(checkout.root, targetName, mode), {
    recursive: true,
    force: true,
  })
  const state: EnvironmentState = {
    ...previous,
    ports: { ...previous.ports, ...sharedPorts },
    processes: {},
    settings,
  }
  writeState(checkout.root, state)
  if (services.length > 0) {
    const project = composeProjectFor(checkout, target, mode, state.ports)
    await composeRemoveWithVolumes(project, services)
    await composeUp(project, services, composeTimeoutOf(target, services))
  }
  await startProcesses(checkout, target, state, processes)
  return describe(checkout, target, mode)
}

const stopProcesses = async (
  checkout: Checkout,
  state: EnvironmentState
): Promise<void> => {
  await Promise.all(Object.values(state.processes).map(stopProcess))
  writeState(checkout.root, { ...state, processes: {} })
}

/* Keeps ports, volumes and containers so the next start resumes where this left off. */
export const stopTarget = async (
  cwd: string,
  targetName: string,
  mode: Mode
): Promise<void> => {
  const checkout = await resolveCheckout(cwd)
  const state = readState(checkout.root, targetName, mode)
  if (state === undefined) return

  const target = await loadTarget(checkout.root, targetName)
  await stopProcesses(checkout, state)
  if (usesCompose(target)) {
    await assertDockerAvailable()
    await composeStop(composeProjectFor(checkout, target, mode, state.ports))
  }
}

/* `test` stops every test lane. */
export const stopAll = async (cwd: string, mode?: Mode): Promise<void> => {
  const checkout = await resolveCheckout(cwd)
  const states = readAllStates(checkout.root).filter(
    (state) =>
      mode === undefined ||
      state.mode === mode ||
      (mode === 'test' && isTestMode(state.mode))
  )
  await Promise.all(
    states.map((state) => stopTarget(cwd, state.target, state.mode))
  )
}

export const resetTarget = async (
  cwd: string,
  targetName: string,
  mode: Mode
): Promise<void> => {
  const checkout = await resolveCheckout(cwd)
  const state = readState(checkout.root, targetName, mode)
  if (state === undefined) return

  const target = await loadTarget(checkout.root, targetName)
  await stopProcesses(checkout, state)
  if (usesCompose(target)) {
    await assertDockerAvailable()
    await composeDownWithVolumes(
      composeProjectFor(checkout, target, mode, state.ports)
    )
  }
  removeState(checkout.root, targetName, mode)
}

interface StartedService {
  readonly checkout: Checkout
  readonly target: Target
  readonly state: EnvironmentState
  readonly definition: Service
}

const startedServiceOf = async (
  cwd: string,
  targetName: string,
  mode: Mode,
  service: string
): Promise<StartedService> => {
  const checkout = await resolveCheckout(cwd)
  const target = await loadTarget(checkout.root, targetName)
  const definition = target.manifest.services[service]
  if (definition === undefined) {
    throw new DevEnvError(`Target "${targetName}" has no service "${service}".`)
  }
  if (definition.kind === 'compose' && definition.shared) {
    throw new DevEnvError(
      `Service "${service}" is shared by every environment on this machine, so no one environment stops or starts it.`
    )
  }
  const state = readState(checkout.root, targetName, mode)
  if (state === undefined) {
    throw new DevEnvError(`Target "${targetName}" has not been started.`)
  }
  return { checkout, target, state, definition }
}

export const stopService = async (
  cwd: string,
  targetName: string,
  mode: Mode,
  service: string
): Promise<void> => {
  const { checkout, target, state, definition } = await startedServiceOf(
    cwd,
    targetName,
    mode,
    service
  )
  if (definition.kind === 'compose') {
    const project = composeProjectFor(checkout, target, mode, state.ports)
    await composeStop(project, [service])
    return
  }
  const recorded = state.processes[service]
  if (recorded !== undefined) await stopProcess(recorded)
}

export const startService = async (
  cwd: string,
  targetName: string,
  mode: Mode,
  service: string
): Promise<void> => {
  const { checkout, target, state, definition } = await startedServiceOf(
    cwd,
    targetName,
    mode,
    service
  )
  if (definition.kind === 'compose') {
    const project = composeProjectFor(checkout, target, mode, state.ports)
    await composeUp(
      project,
      [service],
      definition.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
    return
  }
  await startProcesses(checkout, target, state, [[service, definition]])
}

const runningOrNoneWithoutDocker = async (
  read: () => Promise<ReadonlyMap<string, number | undefined>>
): Promise<ReadonlyMap<string, number | undefined>> => {
  try {
    return await read()
  } catch (error) {
    if (await isDockerAvailable()) throw error
    return new Map()
  }
}

const describe = async (
  checkout: Checkout,
  target: Target,
  mode: Mode
): Promise<EnvironmentInfo> => {
  const state = readState(checkout.root, target.name, mode)
  const ports = state?.ports ?? {}
  const project = composeProjectFor(checkout, target, mode, ports)
  const running = new Map([
    ...(usesCompose(target) && state !== undefined
      ? await runningOrNoneWithoutDocker(() => runningServicesOf(project))
      : []),
    ...(state !== undefined
      ? await runningOrNoneWithoutDocker(() => runningSharedServicesOf(target))
      : []),
  ])

  const services: Record<string, ServiceInfo> = {}
  for (const [name, service] of Object.entries(target.manifest.services)) {
    const port = ports[name]
    if (port === undefined) continue
    const recorded = state?.processes[name]
    const isRunning =
      service.kind === 'compose'
        ? running.has(name)
        : recorded !== undefined && (await isRecordedProcessLive(recorded))
    const address = `${LOOPBACK}:${port}`

    services[name] = {
      kind: service.kind,
      running: isRunning,
      port,
      address,
      ...(service.kind === 'compose' ? {} : { url: `http://${address}` }),
    }
  }

  return {
    target: target.name,
    mode,
    name: project.name,
    ...(usesCompose(target) ? { composeProject: project.name } : {}),
    services,
  }
}

export const describeCheckout = async (cwd: string): Promise<CheckoutInfo> => {
  const checkout = await resolveCheckout(cwd)
  const environments: EnvironmentInfo[] = []

  for (const state of readAllStates(checkout.root)) {
    const target = await loadTarget(checkout.root, state.target)
    environments.push(await describe(checkout, target, state.mode))
  }

  return {
    environmentId: environmentIdOf(checkout.root),
    checkout: checkout.root,
    available: availableTargets(checkout.root),
    environments,
  }
}
