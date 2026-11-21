# @evandam93/dev-env

I kept running into the same wall: two git worktrees, or two coding agents, both trying to start Postgres on port 5432.
One wins, the other fails, and you lose ten minutes figuring out which branch owns what.

dev-env gives every checkout and target its own development environment, with no port pinned anywhere.
You describe a target's services in a `dev-env.ts` beside its code: containers from its `compose.yaml`, and processes such as a dev server.
`dev-env start` gives each service a free port, starts them in order, and returns once every one answers.
A second worktree gets its own containers, ports and data, so branches never fight.
Integration tests get the same setup in a test mode, with empty data for every file and lanes so files can run side by side.

```bash
dev-env start <target>... [--test]
dev-env stop [target]... [--test]
dev-env info [--json]
dev-env reset <target>... [--test]
dev-env affected <target> [--base <ref>] [--list]
```

## What you need

- Node.js 22.17 or later.
- Docker with Compose v2, as `docker compose`.
- A git checkout, since an environment belongs to its checkout.
- A workspace: `pnpm-workspace.yaml`, or `workspaces` in the root `package.json` for npm and Yarn.
- Vitest, for test lanes and `dev-env affected`.

## Install

```bash
pnpm add --save-dev @evandam93/dev-env
# or: npm install --save-dev @evandam93/dev-env
# or: yarn add --dev @evandam93/dev-env
```

Run it through your package manager, such as `pnpm dev-env start api`, or from a script in your root `package.json`.

## Your first target

A target is any workspace directory with a `dev-env.ts`, and it is named after that directory.
Since the name is all a command gets, two targets with the same directory name are refused.

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

The manifest is loaded with tsx, so it can import more of your code, without extensions and through the `paths` of the nearest `tsconfig.json`.

## The manifest

### Compose services

A `compose` service is the service with the same name in the `compose.yaml` next to the manifest.
It must have a healthcheck and publish on loopback, or `dev-env start` refuses it.
Its port reaches Compose as `<NAME>_PORT`, upper-cased with every other character turned into `_`.

### Process services

A `process` service gets its own port as `PORT`, and every service in the target as `<NAME>_PORT`.
Its `command` receives the same ports, plus a `dataDirectory` for anything the process persists itself.
That directory survives `dev-env stop` and goes away on `dev-env reset`, like a container's volume.

- `readinessPath`: the path that answers below 400 once the process is usable.
- `sources`: the directories, relative to the target, that hold the code it runs. `dev-env affected` reads these.
- `timeoutMs`: how long the service may take to become ready. Compose services accept it too.

### Start order and hooks

Compose services start first.
Then the optional `setup` runs with every port, before any process starts, which is where migrations belong.
Processes start one at a time, each ready before the next, because processes that share local state can trip over each other when they open it at the same moment.
Once every process is ready, the optional `afterStart` runs, for data only a running process can make, such as users in a local stand-in for an identity provider.

Both hooks run on every dev start, so make them safe to run again.
A failure stops the start and shows the reason.
Test environments skip both, because each test file sets up its own data.

### Everything else

- `testSettings`: defaults for every test environment of the target, which a command reads from its context's `settings`.
- `shared`: globs for files every integration spec depends on without importing them, for `dev-env affected`.
- `specs.always` and `specs.beforeRelease`: specs `dev-env affected` always runs, and specs it leaves to the full suite, as paths or globs relative to the target.
- `consumers`: other workspace packages whose integration specs use this target's test environment, so `dev-env affected` picks their specs too.
  See [Consumers](#consumers).

## How ports are picked

Each environment has an id: the first eight hex characters of a SHA-256 of the checkout's real path.
Each target gets its own compose project, `<directory>-<id>-<target>`, with `-test` added in test mode and `-test-<lane>` for lanes after the first.
That project name is also the environment's `name`, unique on the machine.
A process's command receives it as `environmentName`, and a test reads it from its `TestEnvironment`.

A service's preferred port comes from a hash of the checkout, target, mode and service, between 20000 and 29999.
dev-env never trusts it blindly.
It skips ports recorded by any other environment in any worktree of the repository, and ports something else is already listening on.
Those records live under a lock in the git common directory, because a probe can't see a sibling's container in the gap between a remove and a create.

A port stays with its environment across restarts, and only `dev-env reset` gives it up.
dev-env never frees a port by killing whatever holds it.

So always ask `dev-env info --json` for an address, and never assume a port.

## Where state lives

`.dev-env/<target>/` inside the checkout holds `state.json`, one log per process, and a `data/` directory for the processes' own data.
Add `.dev-env/` to your `.gitignore`.

A state file written under another environment id is ignored.
A moved or copied checkout never owned those ports and pids.

## Starting, stopping and cleaning up

`dev-env start` exits 0 only once every service answers.
Otherwise it fails, naming the service and showing its log.

`dev-env stop` keeps ports, containers and volumes, so the next start picks up where you left off.
It only signals a process whose pid and start time still match the record, so a recycled pid never gets hit.
Sometimes a process dies and leaves its children running, as when a package manager is killed and its server is not.
A child counts as ours only if it is in the recorded process group and holds the process's log open.
`dev-env stop` stops those children, and `dev-env start` replaces them on the same port.

`dev-env reset` also removes the target's containers, volumes, process data and state.

### Before you delete a worktree

Run `dev-env reset <target>` for each target you started.
A worktree deleted without it leaves containers, volumes and a network behind, and Docker runs out of network addresses at about thirty.

As a safety net, every start removes compose projects that dev-env named for a checkout whose directory is gone.
It never touches another tool's projects or a shared one.
It can't reach a deleted worktree's processes, though, so those are on you.

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

Each entry in `services` has its `port`, `address`, `running` and, for a process, its `url`.

### Lanes

Lanes let test files run side by side without sharing data.
Each lane has its own project, ports, data and state, and lane 1 is the plain `--test` environment.
`startTestEnvironment` uses Vitest's worker number as the lane, so each worker keeps one lane for every file it runs.
Pass `lane` to pick one yourself.

### Fresh data for every file

Every file starts with empty data, but a lane that is fully running keeps its containers and ports.
Each compose service is removed with its volumes and started again, and each process restarts on an empty data directory.
Starting containers is most of what a fresh environment costs, which is why the lane stays up.
A lane that isn't fully running is reset and started from nothing, so a run that died leaves nothing behind for the next one.

A test file must not assume what ran before it in its lane.
Its data is empty, but a `shared` service holds every environment's data on the machine.
Read from it by your environment's `name`, your own IDs, and from your own start.

### Options

- `without`: processes the test doesn't need, which stay stopped.
- `settings`: test-only values for the manifest's commands, such as raised limits. They win over the manifest's `testSettings`, and a dev environment gets neither.
- `exclusive`: hold every lane slot, for timing-sensitive files. See [Lane slots](#lane-slots).

A target can also add a `compose.test.yaml` beside its `compose.yaml`, which Compose merges on top in test mode only.
It's a good place to trade durability for speed, since test data is thrown away after every file anyway.

### Vitest setup

Files leave their lane running for the next file, so remove every lane at the end of the run with `resetTestEnvironments` from a global setup:

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

From the command line, `dev-env reset <target> --test` removes every lane of the target, and `dev-env stop --test` stops them.

### Breaking things on purpose

`stopService` and `startService` let a test take down any service that isn't shared, keeping its port and data:

```ts
const environment = await startTestEnvironment('api')
await environment.stopService('postgres')
// Place orders while the database is down.
await environment.startService('postgres')
```

## Lane slots

When several worktrees run their tests at once, the machine fills up fast and tests start timing out.
Lane slots stop that.
Each test file holds one of the machine's slots from `startTestEnvironment` until its process exits.
A file that finds every slot taken waits, and prints which environments hold them.
After an hour it gives up and names them, so a hung run can't block everyone forever.

The number of slots is what Docker's memory can hold after the shared services, at about 384 MB a lane, capped at one for every 3 host cores, since each lane's processes run on the host.
Set `DEV_ENV_LANE_SLOTS` to override it.

### Add the setup file

Add `@evandam93/dev-env/lane-slot` to Vitest's `setupFiles`, as shown above, so a file takes its slot before any of its hooks run.
Vitest puts no timeout on a setup file, so waiting for a slot doesn't count against the `hookTimeout` of your `beforeAll`.
Without it, the wait happens inside that hook, and a file can fail with `Hook timed out` while another worktree's run holds the machine.

### Exclusive files

A file whose results depend on timing can pass `exclusive: true`, or run with `DEV_ENV_EXCLUSIVE=1`, to hold every slot.
The setup file only reads `DEV_ENV_EXCLUSIVE`, so with `exclusive: true` the wait for the other slots still happens inside the hook.
While an exclusive file waits for running files to finish, no other file takes a slot.
A waiting file holds nothing, so two exclusive files take turns.
A file that already holds its slot keeps it when it asks again, since the exclusive file is waiting for it.

### How slots are stored

A slot is a file under `lanes/` in the machine directory, holding its process's pid and start time.
A process releases its slots when it exits, including on `SIGINT` and `SIGTERM`.
A waiter also clears the slot of a process that died, or whose pid now belongs to something else, so a killed run never keeps one.
The machine directory is `~/.cache/dev-env`, or `$XDG_CACHE_HOME/dev-env`, and `DEV_ENV_HOME` moves it.

## Shared services

Some services are too heavy to run once per lane.
A compose service marked `shared: true` runs once on the machine for every checkout, lane and mode of its target, in its own compose project, `dev-env-shared-<machine>-<target>`.
It suits a service whose data readers can tell apart, such as a telemetry stack each environment writes to under its own `name`.

The first start that needs it starts it from that checkout's `compose.yaml`.
It's never recreated while running, because other runs are using it.
Its ports are recorded in the machine directory and no environment takes them.
`dev-env stop` and `dev-env reset` leave it alone; remove it with `docker compose --project-name <project> down --volumes`.

## Running only the affected specs

`dev-env affected <target>` runs only the integration specs that your changes since the base can reach, and tells you which it picked and why.
`--list` only tells you.

Without `--base`, the base is where your checkout left the remote's default branch: `origin/HEAD`, or else `origin/main` or `origin/master`.
It runs Vitest through your package manager with the target's `vitest.integration.ts`, on files named `*.integration.spec.ts`.
The package manager is the one named in the root `package.json`'s `packageManager`, or else the one whose lockfile is present: `pnpm-lock.yaml`, `yarn.lock` or `package-lock.json`.

Nothing here is kept by hand.
It reads each fact where it already lives:

- The processes a spec starts are the ones its single `startTestEnvironment` call doesn't leave out, so write `without` as a literal list of names.
- A process reaches the directories in its `sources`, plus every file their code imports, through relative imports and the nearest `tsconfig.json`'s `paths`.
  Only what git sees counts, tracked or new, so ignored files like `node_modules` or build output are never read.
- A spec reaches every file it imports, including ones with a query such as Vite's `?raw`, and any workspace package it imports by name, as a whole.
- A change to a shared path runs every spec.
  For the target, those are `dev-env.ts`, `compose.yaml`, `compose.test.yaml`, `package.json`, `tsconfig.json`, `tsconfig.*.json` and `vitest.integration.ts`.
  For the repository, they are the root `package.json`, `tsconfig.json`, `.nvmrc`, `.node-version`, and the package manager's lockfile and configuration, such as `pnpm-workspace.yaml` or `.yarnrc.yml`.
  The manifest's `shared` adds more, relative to the target or from the repository root with a leading `/`, such as migrations or a task runner's configuration.
- Tests, stories and docs run nothing, and neither does a path no spec reaches.

`specs.always` names specs every run includes, such as the product's own scenarios.
`specs.beforeRelease` names specs it never includes, such as a slow replay, which only the full suite runs.
Both take paths or globs, such as `**/*.volume.integration.spec.ts`.
Bindings between processes aren't followed: in a test environment, a process only answers when the spec starts it.

### Consumers

Sometimes a spec in another workspace package starts this target's test environment.
List that package in the target's `consumers`, by the name its `package.json` gives it, or no change will ever pick its specs.

```ts
export default defineManifest({
  services: {/* ... */},
  consumers: {
    '@acme/web': { script: 'tests:integration' },
  },
})
```

Each consumer takes these optional fields:

- `script`: the `package.json` script that runs the chosen specs, `tests:integration` by default.
- `shared`: globs for files only that package's specs depend on.
- `specs.always` and `specs.beforeRelease`: the same as on the target, for that package's specs.

Each consumer is its own group, and the target's own specs are the first group.
A group reads the specs in its package and follows what they import and what the target's processes run.

Two kinds of shared paths apply to a consumer.
The repository's, the target's own and the manifest's `shared` run every consumer's specs, so a change to the target's manifest, compose files or settings reaches all of them.
The package's own `package.json`, `tsconfig.json`, `tsconfig.*.json`, `vitest.config.*` and `vite.config.*`, plus the consumer's `shared`, run only that package's specs.

A spec that doesn't call `startTestEnvironment` is still picked by what it imports.
One whose literal first argument names another target is refused.

A group with no chosen spec is skipped.
Otherwise dev-env runs the consumer's script in the package's directory with the chosen files as arguments: `npm run <script> -- <files>`, `pnpm run <script> <files>` or `yarn run <script> <files>`.
Your script has to pass them on to Vitest.

Groups run one after another, and every group runs even if an earlier one fails.
The command exits 0 only when every group passed, otherwise with the first non-zero exit code, after a last line naming each group and its code.
`--list` shows, for each group, which specs it would run and why.

### Using the selection in a test

`@evandam93/dev-env/affected` exports the same selection (`layoutOf`, `consumerLayoutsOf`, `graphOf`, `selectSpecs` and `forPullRequest`) for a test that pins which specs a change picks.
`graphOf` reads the target from git, so it needs a git checkout.

## What it doesn't do

It holds no credentials.
A target's local passwords are constants in its own compose file.

## License

MIT
