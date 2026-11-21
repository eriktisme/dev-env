---
'@evandam93/dev-env': minor
---

A target can now select the integration specs of the workspace packages that use its test environment: list them in the manifest's `consumers`, and `dev-env affected` chooses each package's specs by what they import and by what the target's processes run, runs each package's own script with the chosen files, and exits non-zero if any group failed, after running them all. A change to the target's manifest, compose files or settings runs every consumer's specs, and one to a package's own `package.json`, `tsconfig.json` or Vitest config runs only that package's. `specs.always` and `specs.beforeRelease` now accept globs. A spec whose literal `startTestEnvironment` target is another target is refused. Fixed: a `shared` glob with a leading `/` never matched a path inside the target's own directory.
