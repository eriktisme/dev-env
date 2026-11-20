# @evandam93/dev-env

One development environment per checkout and target, so git worktrees can run side by side with no ports pinned anywhere.

You describe a target's services in a `dev-env.ts` beside its code: containers from its `compose.yaml`, and processes such as a dev server.
`dev-env start` gives each service a free port of its own, starts them in order, and returns once every one answers.
A second worktree of the same repository gets its own containers, ports and data, so two branches, or two agents, never fight over port 5432.
Integration tests get the same environment in a test mode of their own, with empty data for every file, and lanes so files can run side by side.

```bash
dev-env start <target>... [--test]
dev-env stop [target]... [--test]
dev-env info [--json]
dev-env reset <target>... [--test]
dev-env affected <target> [--base <ref>] [--list]
```

## Requirements

- Node.js 22.17 or later.
- Docker with Compose v2, as `docker compose`.
- git: the repository must be a git checkout, since an environment belongs to its checkout.
- A workspace: `pnpm-workspace.yaml`, or `workspaces` in the root `package.json` for npm and Yarn.
- Vitest, for `startTestEnvironment` lanes and for `dev-env affected`.

## Install

```bash
pnpm add --save-dev @evandam93/dev-env
# or: npm install --save-dev @evandam93/dev-env
# or: yarn add --dev @evandam93/dev-env
```

Then run it through your package manager, such as `pnpm dev-env start api`, or from a script in your root `package.json`.

## A minimal target

A target is any workspace directory with a `dev-env.ts`, named after its directory.
dev-env reads the workspace globs from `pnpm-workspace.yaml`, or else from the root `package.json`'s `workspaces`.
Two targets with one directory name are refused, since the name is all a command gives.

```ts
// apps/api/dev-env.ts
import { defineManifest } from '@evandam93/dev-env'

export default defineManifest({
  services: {
    postgres: { kind: 'compose' },
    api: {
      kind: 'process',
      command: ({ port, ports }) => [
        'node',
        'server.js',
        '--port',
        String(port),
        '--database',
        `postgres://postgres:local@127.0.0.1:${ports.postgres}/postgres`,
      ],
      sources: ['src'],
      readinessPath: '/health',
    },
  },
})
```

```yaml
# apps/api/compose.yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: local
    ports:
      - '127.0.0.1:${POSTGRES_PORT:?allocated by dev-env}:5432'
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', 'postgres']
      interval: 1s
      retries: 30
```

```bash
dev-env start api
dev-env info --json   # every service's port and address
```

The manifest is TypeScript.
dev-env loads it with tsx, so it may import more of your code, without extensions and through the `paths` of the `tsconfig.json` nearest it.

## The manifest

A `compose` service is the service of that name in `compose.yaml` beside the manifest.
It must have a healthcheck and publish on loopback, or `dev-env start` refuses it.
Its port reaches Compose as `<NAME>_PORT`, upper-cased with every other character as `_`, as above.

A `process` service gets its port as `PORT`, and every service in the target is available as `<NAME>_PORT`.
Its `command` receives the same ports, and a `dataDirectory` for whatever the process persists itself.
That directory survives `dev-env stop` and goes on `dev-env reset`, like a container's volume.
Its `readinessPath` is the path that answers below 400 once it is usable.
Its `sources` name the directories, relative to the target, that hold the code it runs, which `dev-env affected` reads.
Each service may set `timeoutMs` for how long it may take to become ready.

Compose services start first.
A manifest's optional `setup` then runs with every service's port, before any process starts, such as migrations a process needs before it can log in.
It runs on every dev start, so it must be safe to run again, and a failure stops the start with its reason.
Test environments skip it, because each test file sets up its own data.
Processes then start one at a time, each ready before the next, since processes that share local state can fail when they open it at the same moment.
A manifest's optional `afterStart` runs once every process is ready, with the same ports, for data only a running process can make, such as users a local stand-in for an identity provider holds.
Like `setup`, it runs on every dev start, must be safe to run again, stops the start with its reason when it fails, and is skipped by test environments.

The other fields are optional too:

- `testSettings`: settings every test environment of the target starts with, which a command reads from its context's `settings`.
- `shared`: globs for what every integration spec is built from without importing it, for `dev-env affected`.
- `specs.always` and `specs.beforeRelease`: integration specs `dev-env affected` always runs, and those it leaves to the full suite.

## Identity

The environment id is the first eight hex characters of a SHA-256 of the checkout's real path.
Each target has its own compose project, `<directory>-<id>-<target>`, with `-test` added in test mode, and `-test-<lane>` for a lane after the first.
That project name is also the environment's `name`, unique on the machine, which a process's command receives as `environmentName` and a test reads from its `TestEnvironment`.

## Ports

A service's preferred port comes from a hash of the checkout, target, mode and service, in the range 20000 to 29999.

A preferred port is never trusted on its own.
Allocation skips ports recorded by any other environment in any worktree of the repository, and ports something else is listening on.
It reads and writes those records under a lock in the git common directory, because a probe cannot see a sibling's container between a remove and a create.

A port stays with its environment across restarts, and `dev-env reset` gives it up.
Nothing is ever freed by stopping whatever holds it.
`dev-env info --json` is the only source of an address, so never assume a port.

## State

`.dev-env/<target>/` inside the checkout holds `state.json`, one log per process, and `data/` for the processes' own data.
Add `.dev-env/` to your `.gitignore`.
A state file written under another environment id is ignored, because a moved or copied checkout never owned those ports and pids.

## Readiness and stopping

`dev-env start` exits 0 only once every service answers, and otherwise fails naming the service and showing its log.

`dev-env stop` keeps ports, containers and volumes, so the next start resumes where it left off.
It signals a process only if its pid and start time still match the record, so a recycled pid is never signalled.
If that process died and left children running, as when a package manager is killed and its server is not, a child counts as ours only if it is in the recorded process group and holds the process's log open.
`dev-env stop` stops those children, and `dev-env start` replaces them on the same port.
`dev-env reset` also removes the target's containers, volumes, process data and state.

Stop what you started before you remove a worktree, with `dev-env reset <target>` for each target.
A worktree deleted without it leaves its containers, volumes and network behind, and Docker runs out of network addresses at about thirty.
So every start first removes each compose project whose recorded working directory is gone and whose name dev-env gave it for that checkout, and never a project of another tool or a shared one.
It cannot reach a deleted worktree's processes.
Compose commands are scoped to the target's project, so they cannot reach another environment.

## Test mode

`--test` is a separate environment for the same target, with its own project, ports, data and state.
Integration tests use it through `startTestEnvironment`:

```ts
import { startTestEnvironment, type TestEnvironment } from '@evandam93/dev-env'
import { beforeAll, it } from 'vitest'

let environment: TestEnvironment

beforeAll(async () => {
  environment = await startTestEnvironment('api')
})

it('answers', async () => {
  const { url } = environment.services.api ?? {}
  // ...
})
```

Each service in `services` has its `port`, `address`, `running` and, for a process, its `url`.

A test environment has lanes, so test files can run side by side without sharing data.
Each lane has its own project, ports, data and state, and lane 1 is the plain `--test` environment.
`startTestEnvironment` uses Vitest's worker number as the lane, so each worker keeps one lane for every file it runs, and `lane` sets it instead.

Every file starts with empty data.
A lane that is fully running keeps its containers and ports, and only its data is thrown away: each compose service is removed with its volumes and started again, and each process starts again on an empty data directory.
Starting containers is most of what a fresh environment costs, which is why the lane stays up.
A lane that is not fully running is reset and started from nothing, so a run that died leaves nothing behind for the next.

A test file must not assume what ran before it in its lane.
Its data is empty, but a service marked `shared` holds every environment's data on the machine, so read it by your environment's `name`, your own IDs and from your own start.

`without` names processes a test does not need, which stay stopped.

`settings` passes test-only values to the manifest's commands, such as raised limits.
A manifest's `testSettings` are every test environment's defaults, and a spec's own `settings` win over them.
A dev environment gets neither.

A target can add `compose.test.yaml` beside its `compose.yaml`, which Compose merges over it in test mode only.
It suits settings that trade durability for speed, since test data is thrown away after every file.

Files leave their lane running for the next, so the run removes every lane at its end with `resetTestEnvironments`, from a Vitest global setup:

```ts
// vitest.integration.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    globalSetup: ['./reset-lanes.ts'],
    setupFiles: ['@evandam93/dev-env/lane-slot'],
  },
})
```

```ts
// reset-lanes.ts
import { resetTestEnvironments } from '@evandam93/dev-env'

export const teardown = () => resetTestEnvironments({ target: 'api' })
```

`dev-env reset <target> --test` removes every lane of the target, and `dev-env stop --test` stops them.

`stopService` and `startService` on that environment trigger a failure, keeping the service's port and data, for any service that is not shared:

```ts
const environment = await startTestEnvironment('api')
await environment.stopService('postgres')
// Place orders while the database is down.
await environment.startService('postgres')
```

## Lane slots

Each test file holds one of the machine's lane slots from `startTestEnvironment` until its process exits, so runs from several worktrees can go at once without slowing each other until tests time out.
A file that finds every slot held waits, and prints which environments hold them.
It gives up after an hour, naming them, so a holder that hangs does not keep a run waiting for good.
The number of slots is what Docker's memory holds after the shared services, at about 384 MB a lane, and no more than one for every 3 of the host's cores, since each lane's processes run on the host.
`DEV_ENV_LANE_SLOTS` sets it instead.

Add `@evandam93/dev-env/lane-slot` to Vitest's `setupFiles`, as above, so a file takes its slot before any of its hooks run.
Vitest puts no timeout on a setup file, so the wait for a slot another run holds never counts against the `hookTimeout` of the `beforeAll` that starts the environment, whose clock starts once the slot is held.
Without it, the wait happens inside that hook, and a file can fail with `Hook timed out` while another worktree's run holds the machine.

A file whose results depend on timing passes `exclusive: true`, or runs with `DEV_ENV_EXCLUSIVE=1`, and holds every slot.
The setup file reads only `DEV_ENV_EXCLUSIVE`, so a file that passes `exclusive: true` still waits for the other slots inside its hook.
While it waits for the files already running, no other file takes a slot, and a file that waits holds nothing, so two exclusive files take turns.
A file that already holds its slot keeps it when it asks again, since the exclusive file is waiting for it.

A slot is a file under `lanes/` in the machine directory, holding its process's pid and start time.
A process that exits releases its slots, also on `SIGINT` and `SIGTERM`, and a waiter removes the slot of a process that died or whose pid now belongs to another process, so a killed run never keeps one.
The machine directory is `~/.cache/dev-env`, or `$XDG_CACHE_HOME/dev-env`, and `DEV_ENV_HOME` moves it.

## Shared services

A compose service marked `shared: true` runs once on the machine, for every checkout, lane and mode of its target, in a compose project of its own, `dev-env-shared-<machine>-<target>`.
It suits a heavy service whose data a reader can tell apart, such as a telemetry stack each environment writes to under its own `name`.
The first start that needs it starts it, from that checkout's `compose.yaml`, and it is never recreated while it runs, because other runs are using it.
Its ports are recorded in the machine directory and taken by no environment.
`dev-env stop` and `dev-env reset` leave it running, and `docker compose --project-name <project> down --volumes` removes it.

## Affected integration specs

`dev-env affected <target> [--base <ref>] [--list]` runs only the target's integration specs that the checkout's changes since the base reach, and says which it chose and why; `--list` only says.
Without `--base`, the base is where the checkout left the remote's default branch: `origin/HEAD`, or else `origin/main` or `origin/master`.
It runs Vitest through the repository's package manager with the target's `vitest.integration.ts`, on the specs named `*.integration.spec.ts`.
The package manager is the one the root `package.json`'s `packageManager` names, or else the one whose lockfile the repository holds: `pnpm-lock.yaml`, `yarn.lock` or `package-lock.json`.

It reads each fact where it already lives, so nothing is kept by hand:

- The processes a spec starts are the ones its single `startTestEnvironment` call does not leave out, so `without` must be a written-out list of names.
- A process reaches the directories its `sources` name, and every file their code imports, following relative imports and the `paths` of the nearest `tsconfig.json`.
  Their code is what git sees there, tracked or new, so nothing git ignores is read, such as `node_modules` or a build's output, which a build running alongside may rewrite.
- A spec reaches every file it imports, also one imported with a query such as Vite's `?raw`, and a workspace package it imports, by the name its `package.json` gives it, as a whole.
- A shared path runs every spec.
  The target's are `dev-env.ts`, `compose.yaml`, `compose.test.yaml`, `package.json`, `tsconfig.json`, `tsconfig.*.json` and `vitest.integration.ts`.
  The repository's are its root `package.json`, `tsconfig.json`, `.nvmrc`, `.node-version`, and its package manager's lockfile and configuration, such as `pnpm-workspace.yaml` or `.yarnrc.yml`.
  The manifest's `shared` adds its own, relative to the target or from the repository with a leading `/`, such as migrations or a task runner's configuration.
- Tests, stories and docs run nowhere, and a path no spec reaches runs nothing.

`specs.always` names specs every run holds, such as the product's own scenarios, and `specs.beforeRelease` those it never holds, such as a slow paced replay, which only the full suite runs.
Bindings between processes are not followed: in a test environment a process answers only when the spec starts it.

`@evandam93/dev-env/affected` exports the same selection, `layoutOf`, `graphOf`, `selectSpecs` and `forPullRequest`, for a test that pins which specs a change chooses.
`graphOf` reads the target from git, so it runs inside a git checkout.

## What it does not do

It holds no credentials: a target's local passwords are constants in its own compose file.

## License

MIT
