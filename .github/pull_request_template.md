## Why

<!--
What was wrong or missing, the way someone using dev-env would run into it.
Name the command, manifest field or test environment where it shows up.
-->

## What changes

<!--
What dev-env does differently now, and why you went this way.
Call out any change to the public API: the manifest, startTestEnvironment, the CLI or dev-env/affected.
-->

## Proof

<!--
How you know it works: the test that failed before and passes now, and the checks you ran.
-->

- [ ] New or changed behavior has a test I saw fail first.
- [ ] `npm run lint`, `npm run type-check`, `npm run tests` and `npm run format:check` pass.
- [ ] `npm run tests:integration` passes, or the change can't reach Docker, processes or ports.
- [ ] The README covers the new behavior, if a user would notice it.
- [ ] A changeset describes the change, or none is needed because nothing published changes.
