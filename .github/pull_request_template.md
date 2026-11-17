## Why

<!--
What was wrong or missing, as someone using dev-env would meet it.
Name the command, the manifest or the test environment it shows up in.
-->

## What changes

<!--
What dev-env does differently now, and why this way.
Call out any change to the public API: the manifest, startTestEnvironment, the CLI or dev-env/affected.
-->

## Proof

<!--
How you know it works: the test that failed before the change and passes after it, and the checks you ran.
-->

- [ ] A new or changed behaviour has a test that was seen failing first.
- [ ] `npm run lint`, `npm run type-check`, `npm run tests` and `npm run format:check` pass.
- [ ] `npm run tests:integration` passes, or the change cannot reach Docker, processes or ports.
- [ ] The README describes the new behaviour, if a user would notice it.
- [ ] A changeset says what changed for the changelog, or none is needed because nothing published changes.
