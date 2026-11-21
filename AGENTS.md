# @evandam93/dev-env

`README.md` has the contract, written for someone who installs the package from npm.
These are the rules that cost the most when missed.

- `dev-env info --json` is the only source of an address. Never assume a port.
- Stop what you started before you remove a worktree, with `dev-env reset <target>` for each target. The next start anywhere removes the compose projects a deleted worktree left, but not its processes.
- Users run the build, not the source: `bin/dev-env.js` loads `dist/`, and `exports` point there. Run `npm run build` after a change before you try the command, and keep relative imports ending in `.ts`, which the build rewrites to `.js`.
- Run `npm run tests:integration` after any change. It builds first and drives the built command line. The unit tests cover port selection, lane slots, workspace discovery and the affected selection, and everything else is proven against real Docker.
- Tests that use the package call `startTestEnvironment`, never the dev environment, so they can stop services and wipe data freely.
- A test file must not assume what ran before it in its lane. Its data is empty, but a service marked `shared` holds every environment's data on the machine, so read it by your environment's `name`, your own IDs and from your own start.
- `src/dev-env.integration.spec.ts` drives the real command line. Add behaviour to it through the commands rather than by importing internals.
- Nothing here may name a repository it runs in. Targets, workspace packages, the package manager and the default branch are read from the repository, so a hard-coded directory, scope or tool is a bug.
- A process service's `sources` decide which integration specs a change reaches. Name every directory of code the process runs, including one it loads beside its own, or a change there runs no spec.
- A workspace package whose specs use a target's environment is listed in that target's `consumers`, or no change selects its specs.
- A change a user would notice adds a changeset, with `npm run changeset`. Never edit `CHANGELOG.md` by hand.
