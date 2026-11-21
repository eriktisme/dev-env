# @evandam93/dev-env

## 0.3.0

### Minor Changes

- [#7](https://github.com/eriktisme/dev-env/pull/7) [`f2dca3c`](https://github.com/eriktisme/dev-env/commit/f2dca3cb4c1f2d694253991a029cc1892420e232) Thanks [@eriktisme](https://github.com/eriktisme)! - A target can now select the integration specs of the workspace packages that use its test environment: list them in the manifest's `consumers`, and `dev-env affected` chooses each package's specs by what they import and by what the target's processes run, runs each package's own script with the chosen files, and exits non-zero if any group failed, after running them all. A change to the target's manifest, compose files or settings runs every consumer's specs, and one to a package's own `package.json`, `tsconfig.json` or Vitest config runs only that package's. `specs.always` and `specs.beforeRelease` now accept globs. A spec whose literal `startTestEnvironment` target is another target is refused. Fixed: a `shared` glob with a leading `/` never matched a path inside the target's own directory.

## 0.2.0

### Minor Changes

- [#5](https://github.com/eriktisme/dev-env/pull/5) [`d05c0c9`](https://github.com/eriktisme/dev-env/commit/d05c0c9e7e09e9284b42c94f70671877af0499b6) Thanks [@eriktisme](https://github.com/eriktisme)! - A test file can now wait for a lane slot outside its hook timeout: add `@evandam93/dev-env/lane-slot` to Vitest's `setupFiles`, and the file takes its slot before any of its hooks run, where Vitest puts no timeout, so the `beforeAll` that starts the environment only starts its clock once the slot is held. Before, the wait counted against that hook's timeout, so while another worktree's run held the machine, files failed with `Hook timed out` without any assertion failing. A wait for a slot now gives up after an hour, naming who holds them, and a file that already holds a slot keeps it when it asks again while another file waits to run alone.

## 0.1.2

### Patch Changes

- [#3](https://github.com/eriktisme/dev-env/pull/3) [`6e768ee`](https://github.com/eriktisme/dev-env/commit/6e768eeeeccb416714206fd4833bfdde2a864df3) Thanks [@eriktisme](https://github.com/eriktisme)! - `dev-env affected` and `graphOf` now read only the code git sees under a process's `sources`, tracked or new, and skip what git ignores, such as build output. Before, a build that rewrote its output while the selection read it could fail the selection with ENOENT, and a file deleted while it ran is now read as reaching nothing.

## 0.1.1

### Patch Changes

- [#1](https://github.com/eriktisme/dev-env/pull/1) [`dc91c00`](https://github.com/eriktisme/dev-env/commit/dc91c00d3aac8fd3bccab3c0b791747bad16fe7b) Thanks [@eriktisme](https://github.com/eriktisme)! - `dev-env affected` now runs a spec when a file it imports with a query, such as Vite's `?raw`, changes. Before, the query made the path match no file, so the change ran nothing.
