---
'@evandam93/dev-env': minor
---

A test file can now wait for a lane slot outside its hook timeout: add `@evandam93/dev-env/lane-slot` to Vitest's `setupFiles`, and the file takes its slot before any of its hooks run, where Vitest puts no timeout, so the `beforeAll` that starts the environment only starts its clock once the slot is held. Before, the wait counted against that hook's timeout, so while another worktree's run held the machine, files failed with `Hook timed out` without any assertion failing. A wait for a slot now gives up after an hour, naming who holds them, and a file that already holds a slot keeps it when it asks again while another file waits to run alone.
