import { execFile, spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { startTestEnvironment } from './test-environment.ts'

const exec = promisify(execFile)

/*
 * Lane slots and shared services are machine-wide, so these tests keep theirs
 * apart from real runs, and every command they run inherits it.
 */
process.env.DEV_ENV_HOME = mkdtempSync(join(tmpdir(), 'dev-env-home-'))

/*
 * The built package, as a user installs it: its command line, and its entry
 * point for a test that holds a lane. `pnpm build` runs first.
 */
const CLI = fileURLToPath(new URL('../bin/dev-env.js', import.meta.url))
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const LANE_SLOT = fileURLToPath(
  new URL('../dist/lane-slot.js', import.meta.url)
)
const VITEST = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url)
)

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const cli = async (cwd: string, ...args: string[]): Promise<CliResult> => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as CliResult & { readonly code: number }
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }
  }
}

const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

const STORE_COMPOSE = `services:
  store:
    image: busybox:1.37
    command: sh -c "echo ok > /data/health.txt && httpd -f -p 8080 -h /data"
    ports:
      - '127.0.0.1:\${STORE_PORT:?allocated by dev-env}:8080'
    volumes:
      - data:/data
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/health.txt']
      interval: 1s
      timeout: 2s
      retries: 30
volumes:
  data:
`

const STORE_MANIFEST = `export default { services: { store: { kind: 'compose' } } }\n`

const CACHE_SERVICE = `  cache:
    image: busybox:1.37
    command: sh -c "echo cache > /tmp/health.txt && httpd -f -p 8080 -h /tmp"
    ports:
      - '127.0.0.1:\${CACHE_PORT:?allocated by dev-env}:8080'
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/health.txt']
      interval: 1s
      timeout: 2s
      retries: 30
`

const STORE_AND_CACHE_COMPOSE = STORE_COMPOSE.replace(
  'services:\n',
  `services:\n${CACHE_SERVICE}`
)

const STORE_AND_CACHE_MANIFEST = `export default { services: { store: { kind: 'compose' }, cache: { kind: 'compose' } } }\n`

const STORE_AND_SHARED_CACHE_MANIFEST = `export default { services: { store: { kind: 'compose' }, cache: { kind: 'compose', shared: true } } }\n`

// Starts a test environment in its own process and keeps that process alive, as a test file does while it runs.
const LANE_HOLDER = `import { startTestEnvironment } from ${JSON.stringify(
  ENTRY
)}
await startTestEnvironment('store', { cwd: process.argv[2], lane: Number(process.argv[3]) })
console.log('started')
setInterval(() => {}, 1e6)
`

/*
 * A test file as a user writes one, run by Vitest with the package's setup
 * file and a hook timeout shorter than its wait for a slot. Globals, because
 * the workspace has no Vitest of its own to import.
 */
const WAITING_HOOK_TIMEOUT_MS = 15_000

const WAITING_SPEC = `import { startTestEnvironment } from ${JSON.stringify(ENTRY)}
let environment
beforeAll(async () => {
  environment = await startTestEnvironment('store')
})
it('starts once a slot is free', () => {
  expect(environment.services.store.running).toBe(true)
})
`

const WAITING_CONFIG = `export default {
  test: {
    globals: true,
    include: ['waits.spec.mjs'],
    setupFiles: [${JSON.stringify(LANE_SLOT)}],
    hookTimeout: ${WAITING_HOOK_TIMEOUT_MS},
  },
}
`

// Its setup reads the store, so a line holding "ok" proves the store was healthy first, and each line is one run.
const STORE_WITH_SETUP_MANIFEST = `import { appendFileSync } from 'node:fs'
export default {
  services: { store: { kind: 'compose' } },
  setup: async ({ ports }) => {
    const health = await (await fetch('http://127.0.0.1:' + ports.store + '/health.txt')).text()
    appendFileSync(new URL('./setup.txt', import.meta.url), health)
  },
}
`

const FAILING_SETUP_MANIFEST = `export default {
  services: { store: { kind: 'compose' } },
  setup: async () => { throw new Error('no migrations') },
}
`

const WEB_SERVER = `import { createServer } from 'node:http'
createServer((_, response) => response.end('web ok')).listen(process.env.PORT, '127.0.0.1')
`

const WEB_MANIFEST = `export default {
  services: {
    web: {
      kind: 'process',
      command: () => [process.execPath, 'server.mjs'],
      readinessPath: '/',
    },
  },
}
`

// A manifest written as TypeScript, importing its command through a tsconfig path and without an extension.
const TYPED_MANIFEST = `import { command, type Command } from '@/command'
const web: { kind: 'process'; command: Command; readinessPath: string } = {
  kind: 'process',
  command,
  readinessPath: '/',
}
export default { services: { web } }
`

const TYPED_COMMAND = `export type Command = (context: { readonly port: number }) => readonly string[]
export const command: Command = () => [process.execPath, 'server.mjs']
`

const TYPED_TSCONFIG = `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }
`

// Asks the running web server, so a line holding "web ok" proves every process was ready first, and each line is one run.
const WEB_WITH_AFTER_START_MANIFEST = `import { appendFileSync } from 'node:fs'
export default {
  services: {
    web: {
      kind: 'process',
      command: () => [process.execPath, 'server.mjs'],
      readinessPath: '/',
    },
  },
  afterStart: async ({ ports }) => {
    const answer = await (await fetch('http://127.0.0.1:' + ports.web + '/')).text()
    appendFileSync(new URL('./after-start.txt', import.meta.url), answer + '\\n')
  },
}
`

// Counts its own starts in its data directory, as a local database would keep its rows.
const COUNTING_SERVER = `import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const file = join(process.argv[2], 'starts')
const starts = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1
writeFileSync(file, String(starts))
createServer((_, response) => response.end(String(starts))).listen(process.env.PORT, '127.0.0.1')
`

const COUNTING_MANIFEST = `export default {
  services: {
    web: {
      kind: 'process',
      command: ({ dataDirectory }) => [process.execPath, 'server.mjs', dataDirectory],
      readinessPath: '/',
    },
  },
}
`

const CRASH_MANIFEST = `export default {
  services: {
    web: {
      kind: 'process',
      command: () => [process.execPath, '-e', 'console.error("boom"); process.exit(3)'],
      readinessPath: '/',
    },
  },
}
`

// Its shell records its own pid, so a test can kill it and leave the server behind.
const SHELL_WRAPPED_MANIFEST = `export default {
  services: {
    web: {
      kind: 'process',
      command: () => ['sh', '-c', process.execPath + ' server.mjs & echo $$ > leader.pid; wait'],
      readinessPath: '/',
    },
  },
}
`

type Files = Readonly<Record<string, string>>

const cleanups: (() => Promise<unknown>)[] = []

// Every target is a workspace under apps/, which the root package.json declares.
const writeRoot = (root: string): void =>
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*'] })
  )

const writeTarget = (root: string, name: string, files: Files): void => {
  const directory = join(root, 'apps', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, private: true, type: 'module' })
  )
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(directory, file), content)
  }
}

const createWorkspace = async (
  targets: Readonly<Record<string, Files>>
): Promise<string> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-env-')))
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
  await git(root, 'init', '--quiet')
  writeRoot(root)
  for (const [name, files] of Object.entries(targets)) {
    writeTarget(root, name, files)
    cleanups.unshift(() => cli(root, 'reset', name))
    cleanups.unshift(() => cli(root, 'reset', name, '--test'))
  }
  return root
}

const addWorktree = async (
  root: string,
  targets: Readonly<Record<string, Files>>
): Promise<string> => {
  await git(
    root,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init'
  )
  const worktree = `${root}-worktree`
  await git(root, 'worktree', 'add', '--quiet', '-b', 'sibling', worktree)
  cleanups.push(async () => rmSync(worktree, { recursive: true, force: true }))
  writeRoot(worktree)
  for (const [name, files] of Object.entries(targets)) {
    writeTarget(worktree, name, files)
    cleanups.unshift(() => cli(worktree, 'reset', name))
  }
  return worktree
}

const info = async (cwd: string) => {
  const result = await cli(cwd, 'info', '--json')
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as {
    readonly environments: readonly {
      readonly target: string
      readonly mode: string
      readonly composeProject?: string
      readonly services: Readonly<
        Record<string, { readonly port: number; readonly running: boolean }>
      >
    }[]
  }
}

const portOf = async (
  cwd: string,
  target: string,
  service: string,
  mode = 'dev'
): Promise<number> => {
  const { environments } = await info(cwd)
  const environment = environments.find(
    (candidate) => candidate.target === target && candidate.mode === mode
  )
  const port = environment?.services[service]?.port
  if (port === undefined) throw new Error(`${target}/${service} has no port`)
  return port
}

const get = (port: number, path: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`)

const seedStore = async (
  root: string,
  project: string,
  value: string,
  { service = 'store', directory = '/data' } = {}
): Promise<void> => {
  await exec(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--file',
      join(root, 'apps/store/compose.yaml'),
      'exec',
      service,
      'sh',
      '-c',
      `echo ${value} > ${directory}/seed.txt`,
    ],
    { env: { ...process.env, STORE_PORT: '1', CACHE_PORT: '1' } }
  )
}

const composeProject = async (root: string, mode = 'dev'): Promise<string> => {
  const { environments } = await info(root)
  const project = environments.find(
    (environment) => environment.target === 'store' && environment.mode === mode
  )?.composeProject
  if (project === undefined) throw new Error('store has no compose project')
  return project
}

const killLeader = async (root: string): Promise<number> => {
  const pid = Number(readFileSync(join(root, 'apps/web/leader.pid'), 'utf8'))
  process.kill(pid, 'SIGKILL')
  while (isRunning(pid)) await sleep(50)
  return pid
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const STORE = {
  store: { 'compose.yaml': STORE_COMPOSE, 'dev-env.ts': STORE_MANIFEST },
}
const WEB = { web: { 'dev-env.ts': WEB_MANIFEST, 'server.mjs': WEB_SERVER } }

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('compose services', () => {
  it('returns only once healthy, keeps data across stop, wipes it on reset', async () => {
    const root = await createWorkspace(STORE)

    const started = await cli(root, 'start', 'store')
    expect(started.stderr).toBe('')
    expect(started.code).toBe(0)

    const port = await portOf(root, 'store', 'store')
    expect(await (await get(port, '/health.txt')).text()).toBe('ok\n')

    await seedStore(root, await composeProject(root), 'kept')

    expect((await cli(root, 'stop', 'store')).code).toBe(0)
    await expect(get(port, '/health.txt')).rejects.toThrow()

    expect((await cli(root, 'start', 'store')).code).toBe(0)
    expect(await portOf(root, 'store', 'store')).toBe(port)
    expect(await (await get(port, '/seed.txt')).text()).toBe('kept\n')

    expect((await cli(root, 'reset', 'store')).code).toBe(0)
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    expect((await get(port, '/seed.txt')).status).toBe(404)
  })

  it('refuses a service without a healthcheck or published off loopback', async () => {
    const root = await createWorkspace({
      unhealthy: {
        'dev-env.ts': `export default { services: { box: { kind: 'compose' } } }\n`,
        'compose.yaml': `services:
  box:
    image: busybox:1.37
    command: sleep 60
    ports:
      - '127.0.0.1:\${BOX_PORT:?}:8080'
`,
      },
      exposed: {
        'dev-env.ts': `export default { services: { box: { kind: 'compose' } } }\n`,
        'compose.yaml': `services:
  box:
    image: busybox:1.37
    command: sleep 60
    ports:
      - '\${BOX_PORT:?}:8080'
    healthcheck:
      test: ['CMD', 'true']
`,
      },
    })

    const unhealthy = await cli(root, 'start', 'unhealthy')
    expect(unhealthy.code).toBe(1)
    expect(unhealthy.stderr).toContain('needs a healthcheck')

    const exposed = await cli(root, 'start', 'exposed')
    expect(exposed.code).toBe(1)
    expect(exposed.stderr).toContain('must publish its port on 127.0.0.1')
  })

  it('keeps two checkouts apart, and stopping one leaves the other running', async () => {
    const root = await createWorkspace(STORE)
    const sibling = await addWorktree(root, STORE)

    expect((await cli(root, 'start', 'store')).code).toBe(0)
    expect((await cli(sibling, 'start', 'store')).code).toBe(0)

    const port = await portOf(root, 'store', 'store')
    const siblingPort = await portOf(sibling, 'store', 'store')
    expect(siblingPort).not.toBe(port)
    expect(await composeProject(sibling)).not.toBe(await composeProject(root))

    expect((await cli(sibling, 'stop')).code).toBe(0)
    await expect(get(siblingPort, '/health.txt')).rejects.toThrow()
    expect((await get(port, '/health.txt')).status).toBe(200)
  })

  it('removes what a deleted worktree left running on the next start', async () => {
    const root = await createWorkspace(STORE)
    const sibling = await addWorktree(root, STORE)
    expect((await cli(sibling, 'start', 'store')).code).toBe(0)
    const project = await composeProject(sibling)

    rmSync(sibling, { recursive: true, force: true })
    await git(root, 'worktree', 'prune')
    expect((await cli(root, 'start', 'store')).code).toBe(0)

    const left = async (...args: string[]) =>
      (
        await exec('docker', [
          ...args,
          '--quiet',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ])
      ).stdout.trim()
    expect(await left('ps', '--all')).toBe('')
    expect(await left('network', 'ls')).toBe('')
    expect(await left('volume', 'ls')).toBe('')
  })

  it('runs a test environment beside dev without touching its data', async () => {
    const root = await createWorkspace(STORE)
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    const devPort = await portOf(root, 'store', 'store')
    await seedStore(root, await composeProject(root), 'dev-data')

    const environment = await startTestEnvironment('store', { cwd: root })
    const testPort = environment.services.store?.port as number
    expect(testPort).not.toBe(devPort)
    expect((await get(testPort, '/seed.txt')).status).toBe(404)

    await environment.stop()
    await expect(get(testPort, '/health.txt')).rejects.toThrow()
    expect(await (await get(devPort, '/seed.txt')).text()).toBe('dev-data\n')

    const { environments } = await info(root)
    expect(environments.map((candidate) => candidate.mode)).toEqual(['dev'])
  })

  it('lets a test stop one service and bring it back with its data and port', async () => {
    const root = await createWorkspace(STORE)
    const environment = await startTestEnvironment('store', { cwd: root })
    const port = environment.services.store?.port as number
    await seedStore(root, await composeProject(root, 'test'), 'survives')

    await environment.stopService('store')
    await expect(get(port, '/health.txt')).rejects.toThrow()

    await environment.startService('store')
    expect(await (await get(port, '/seed.txt')).text()).toBe('survives\n')

    await expect(environment.stopService('missing')).rejects.toThrow(
      'has no service "missing"'
    )
    await environment.stop()
  })

  it('gives the next test file a warm lane on the same ports, emptied', async () => {
    const root = await createWorkspace(STORE)
    const first = await startTestEnvironment('store', { cwd: root, lane: 1 })
    await seedStore(
      root,
      await composeProject(root, 'test'),
      'from-the-last-file'
    )

    const next = await startTestEnvironment('store', { cwd: root, lane: 1 })
    const storePort = next.services.store?.port as number
    expect(storePort).toBe(first.services.store?.port)
    expect((await get(storePort, '/seed.txt')).status).toBe(404)
  })

  it('runs a shared service once for every checkout, lane and mode, and keeps its data', async () => {
    const files = {
      store: {
        'compose.yaml': STORE_AND_CACHE_COMPOSE,
        'dev-env.ts': STORE_AND_SHARED_CACHE_MANIFEST,
      },
    }
    const root = await createWorkspace(files)
    const sibling = await addWorktree(root, files)
    cleanups.unshift(() => cli(sibling, 'reset', 'store', '--test'))
    const one = await startTestEnvironment('store', { cwd: root, lane: 1 })
    const cachePort = one.services.cache?.port as number
    const { stdout } = await exec('docker', [
      'ps',
      '--filter',
      `publish=${cachePort}`,
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
    ])
    const [container = '', sharedProject = ''] = stdout.trim().split('\t')
    cleanups.push(() =>
      exec('docker', [
        'compose',
        '--project-name',
        sharedProject,
        'down',
        '--volumes',
      ])
    )
    await exec('docker', [
      'exec',
      container,
      'sh',
      '-c',
      'echo kept > /tmp/seed.txt',
    ])

    const two = await startTestEnvironment('store', { cwd: root, lane: 2 })
    const next = await startTestEnvironment('store', { cwd: root, lane: 1 })
    const elsewhere = await startTestEnvironment('store', {
      cwd: sibling,
      lane: 1,
    })
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    for (const environment of [two, next, elsewhere])
      expect(environment.services.cache?.port).toBe(cachePort)
    expect(await portOf(root, 'store', 'cache')).toBe(cachePort)
    expect(await (await get(cachePort, '/seed.txt')).text()).toBe('kept\n')

    const names = [one, two, elsewhere].map(({ name }) => name)
    expect(new Set(names).size).toBe(3)

    expect((await cli(root, 'reset', 'store', '--test')).code).toBe(0)
    expect((await get(cachePort, '/health.txt')).status).toBe(200)
    await expect(one.stopService('cache')).rejects.toThrow('shared')
  })

  it('makes a lane wait for a slot, and frees the slot of a run that was killed', async () => {
    const root = await createWorkspace(STORE)
    writeFileSync(join(root, 'lane-holder.mjs'), LANE_HOLDER)
    const environment = {
      ...process.env,
      DEV_ENV_HOME: mkdtempSync(join(tmpdir(), 'dev-env-home-')),
      DEV_ENV_LANE_SLOTS: '1',
    }
    const lane = (number: number) => {
      const child = spawn(
        process.execPath,
        [join(root, 'lane-holder.mjs'), root, String(number)],
        { env: environment }
      )
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      cleanups.unshift(async () => child.kill('SIGKILL'))
      return { child, output: () => output }
    }
    const until = async (read: () => string, text: string) => {
      const deadline = Date.now() + 120_000
      while (!read().includes(text)) {
        if (Date.now() > deadline)
          throw new Error(`never printed ${text}: ${read()}`)
        await sleep(100)
      }
    }

    const first = lane(1)
    await until(first.output, 'started')
    const second = lane(2)
    await until(
      second.output,
      'waits for a lane slot: all 1 lane slots are held by store test'
    )
    expect(second.output()).not.toContain('started')

    first.child.kill('SIGKILL')
    await until(second.output, 'started')
  })

  it('waits for a slot outside the hook timeout, so a file that waits longer than it still passes', async () => {
    const root = await createWorkspace(STORE)
    writeFileSync(join(root, 'lane-holder.mjs'), LANE_HOLDER)
    writeFileSync(join(root, 'waits.spec.mjs'), WAITING_SPEC)
    writeFileSync(join(root, 'vitest.config.mjs'), WAITING_CONFIG)
    const environment = {
      ...process.env,
      DEV_ENV_HOME: mkdtempSync(join(tmpdir(), 'dev-env-home-')),
      DEV_ENV_LANE_SLOTS: '1',
    }
    const output = (child: ReturnType<typeof spawn>) => {
      let text = ''
      child.stdout?.on('data', (chunk) => (text += chunk))
      child.stderr?.on('data', (chunk) => (text += chunk))
      cleanups.unshift(async () => child.kill('SIGKILL'))
      return () => text
    }
    const until = async (read: () => string, text: string) => {
      const deadline = Date.now() + 120_000
      while (!read().includes(text)) {
        if (Date.now() > deadline)
          throw new Error(`never printed ${text}: ${read()}`)
        await sleep(100)
      }
    }

    const holder = spawn(
      process.execPath,
      [join(root, 'lane-holder.mjs'), root, '2'],
      { env: environment }
    )
    await until(output(holder), 'started')

    const run = spawn(process.execPath, [VITEST, 'run'], {
      cwd: root,
      env: environment,
    })
    const runOutput = output(run)
    const exited = new Promise<number | null>((resolve) =>
      run.once('exit', resolve)
    )
    await until(
      runOutput,
      'waits for a lane slot: all 1 lane slots are held by store test-2'
    )
    await sleep(WAITING_HOOK_TIMEOUT_MS + 5_000)
    holder.kill('SIGKILL')

    const code = await exited
    expect(runOutput()).not.toContain('Hook timed out')
    expect(code, runOutput()).toBe(0)
  })

  it('keeps lanes apart, so files running side by side share no data, and resets them all', async () => {
    const root = await createWorkspace(STORE)
    const one = await startTestEnvironment('store', { cwd: root, lane: 1 })
    const two = await startTestEnvironment('store', { cwd: root, lane: 2 })
    const portOne = one.services.store?.port as number
    const portTwo = two.services.store?.port as number
    expect(portTwo).not.toBe(portOne)

    await seedStore(root, await composeProject(root, 'test'), 'lane-one')
    expect((await get(portTwo, '/seed.txt')).status).toBe(404)

    expect((await cli(root, 'reset', 'store', '--test')).code).toBe(0)
    await expect(get(portOne, '/health.txt')).rejects.toThrow()
    await expect(get(portTwo, '/health.txt')).rejects.toThrow()
    expect((await info(root)).environments).toEqual([])
  })

  it('starts a service added to the manifest after the first start', async () => {
    const root = await createWorkspace(STORE)
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    const storePort = await portOf(root, 'store', 'store')

    writeTarget(root, 'store', {
      'compose.yaml': STORE_AND_CACHE_COMPOSE,
      'dev-env.ts': STORE_AND_CACHE_MANIFEST,
    })

    const { environments } = await info(root)
    expect(environments[0]?.services.store?.running).toBe(true)

    const started = await cli(root, 'start', 'store')
    expect(started.stderr).toBe('')
    expect(started.code).toBe(0)

    const cachePort = await portOf(root, 'store', 'cache')
    expect(await portOf(root, 'store', 'store')).toBe(storePort)
    expect(await (await get(cachePort, '/health.txt')).text()).toBe('cache\n')
  })

  it('stops a service removed from the manifest and compose file', async () => {
    const root = await createWorkspace({
      store: {
        'compose.yaml': STORE_AND_CACHE_COMPOSE,
        'dev-env.ts': STORE_AND_CACHE_MANIFEST,
      },
    })
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    const cachePort = await portOf(root, 'store', 'cache')

    writeTarget(root, 'store', STORE.store)

    const started = await cli(root, 'start', 'store')
    expect(started.stderr).toBe('')
    expect(started.code).toBe(0)
    await expect(get(cachePort, '/health.txt')).rejects.toThrow()
  })

  it('runs the setup on every dev start once the store is healthy, and never for a test environment', async () => {
    const root = await createWorkspace({
      store: {
        'compose.yaml': STORE_COMPOSE,
        'dev-env.ts': STORE_WITH_SETUP_MANIFEST,
      },
    })
    const runs = () =>
      readFileSync(join(root, 'apps', 'store', 'setup.txt'), 'utf8')

    expect((await cli(root, 'start', 'store')).code).toBe(0)
    expect(runs()).toBe('ok\n')
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    expect(runs()).toBe('ok\nok\n')

    expect((await cli(root, 'start', 'store', '--test')).code).toBe(0)
    expect(runs()).toBe('ok\nok\n')
  })

  it('runs after starting on every dev start once the processes are ready, and never for a test environment', async () => {
    const root = await createWorkspace({
      web: {
        'dev-env.ts': WEB_WITH_AFTER_START_MANIFEST,
        'server.mjs': WEB_SERVER,
      },
    })
    const runs = () =>
      readFileSync(join(root, 'apps', 'web', 'after-start.txt'), 'utf8')

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(runs()).toBe('web ok\n')
    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(runs()).toBe('web ok\nweb ok\n')

    expect((await cli(root, 'start', 'web', '--test')).code).toBe(0)
    expect(runs()).toBe('web ok\nweb ok\n')
  })

  it('fails the start with the reason when the setup fails', async () => {
    const root = await createWorkspace({
      store: {
        'compose.yaml': STORE_COMPOSE,
        'dev-env.ts': FAILING_SETUP_MANIFEST,
      },
    })

    const started = await cli(root, 'start', 'store')
    expect(started.code).not.toBe(0)
    expect(started.stderr).toContain('Setup of "store" failed: no migrations')
  })

  it('reports a broken compose file instead of calling its services stopped', async () => {
    const root = await createWorkspace(STORE)
    expect((await cli(root, 'start', 'store')).code).toBe(0)
    const project = await composeProject(root)

    writeTarget(root, 'store', { 'compose.yaml': 'services: [broken' })

    const result = await cli(root, 'info')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(project)
    expect(result.stderr).not.toContain('    at ')

    writeTarget(root, 'store', STORE.store)
  })
})

describe('process services', () => {
  it('starts on its allocated port, reuses a live process, and stops it', async () => {
    const root = await createWorkspace(WEB)

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    const port = await portOf(root, 'web', 'web')
    expect(await (await get(port, '/')).text()).toBe('web ok')

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(await portOf(root, 'web', 'web')).toBe(port)

    expect((await cli(root, 'stop', 'web')).code).toBe(0)
    await expect(get(port, '/')).rejects.toThrow()
    const { environments } = await info(root)
    expect(environments[0]?.services.web?.running).toBe(false)
  })

  it('keeps its own data across stop and loses it on reset', async () => {
    const root = await createWorkspace({
      web: { 'dev-env.ts': COUNTING_MANIFEST, 'server.mjs': COUNTING_SERVER },
    })

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    const port = await portOf(root, 'web', 'web')
    expect(await (await get(port, '/')).text()).toBe('1')

    expect((await cli(root, 'stop', 'web')).code).toBe(0)
    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(await (await get(port, '/')).text()).toBe('2')

    expect((await cli(root, 'reset', 'web')).code).toBe(0)
    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(
      await (await get(await portOf(root, 'web', 'web'), '/')).text()
    ).toBe('1')
  })

  it('lets a test stop one process and bring it back on its port', async () => {
    const root = await createWorkspace(WEB)
    const environment = await startTestEnvironment('web', { cwd: root })
    const port = environment.services.web?.port as number

    await environment.stopService('web')
    await expect(get(port, '/')).rejects.toThrow()

    await environment.startService('web')
    expect(await (await get(port, '/')).text()).toBe('web ok')
    await environment.stop()
  })

  it('stops a server left behind when the process that started it dies', async () => {
    const root = await createWorkspace({
      web: { 'dev-env.ts': SHELL_WRAPPED_MANIFEST, 'server.mjs': WEB_SERVER },
    })
    expect((await cli(root, 'start', 'web')).code).toBe(0)
    const port = await portOf(root, 'web', 'web')

    await killLeader(root)
    expect((await get(port, '/')).status).toBe(200)
    const { environments } = await info(root)
    expect(environments[0]?.services.web?.running).toBe(true)

    expect((await cli(root, 'stop', 'web')).code).toBe(0)
    await expect(get(port, '/')).rejects.toThrow()
  })

  it('replaces a server left behind on the next start, keeping its port', async () => {
    const root = await createWorkspace({
      web: { 'dev-env.ts': SHELL_WRAPPED_MANIFEST, 'server.mjs': WEB_SERVER },
    })
    expect((await cli(root, 'start', 'web')).code).toBe(0)
    const port = await portOf(root, 'web', 'web')
    const killed = await killLeader(root)

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(await portOf(root, 'web', 'web')).toBe(port)
    expect((await get(port, '/')).status).toBe(200)

    await killLeader(root).then((restarted) =>
      expect(restarted).not.toBe(killed)
    )
    expect((await cli(root, 'stop', 'web')).code).toBe(0)
    await expect(get(port, '/')).rejects.toThrow()
  })

  it('skips a port something else is listening on, and never stops it', async () => {
    const root = await createWorkspace(WEB)
    expect((await cli(root, 'start', 'web')).code).toBe(0)
    const port = await portOf(root, 'web', 'web')
    expect((await cli(root, 'stop', 'web')).code).toBe(0)

    const squatter = createServer((_, response) => response.end('squatter'))
    await new Promise<void>((resolve) =>
      squatter.listen(port, '127.0.0.1', resolve)
    )
    cleanups.push(() => new Promise((resolve) => squatter.close(resolve)))

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    const nextPort = await portOf(root, 'web', 'web')
    expect(nextPort).not.toBe(port)
    expect(await (await get(nextPort, '/')).text()).toBe('web ok')
    expect((await cli(root, 'stop', 'web')).code).toBe(0)
    expect(await (await get(port, '/')).text()).toBe('squatter')
  })

  it('fails naming the service, with its log, when it exits before ready', async () => {
    const root = await createWorkspace({
      crash: { 'dev-env.ts': CRASH_MANIFEST },
    })

    const result = await cli(root, 'start', 'crash')

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Service "web" exited before it was ready')
    expect(result.stderr).toContain('boom')
  })
})

describe('a manifest', () => {
  it('imports TypeScript of its own, without extensions and through its tsconfig paths', async () => {
    const root = await createWorkspace({
      typed: {
        'dev-env.ts': TYPED_MANIFEST,
        'command.ts': TYPED_COMMAND,
        'tsconfig.json': TYPED_TSCONFIG,
        'server.mjs': WEB_SERVER,
      },
    })

    const result = await cli(root, 'start', 'typed')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(
      await (await get(await portOf(root, 'typed', 'web'), '/')).text()
    ).toBe('web ok')
  })

  it('is found in a workspace that pnpm-workspace.yaml declares at any depth', async () => {
    const root = await createWorkspace({})
    rmSync(join(root, 'package.json'))
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'services/**'\n"
    )
    const directory = join(root, 'services', 'billing', 'web')
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'billing-web', private: true, type: 'module' })
    )
    writeFileSync(join(directory, 'dev-env.ts'), WEB_MANIFEST)
    writeFileSync(join(directory, 'server.mjs'), WEB_SERVER)
    cleanups.unshift(() => cli(root, 'reset', 'web'))

    expect((await cli(root, 'start', 'web')).code).toBe(0)
    expect(
      await (await get(await portOf(root, 'web', 'web'), '/')).text()
    ).toBe('web ok')
  })
})
