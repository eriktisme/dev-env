---
'@evandam93/dev-env': minor
---

Add a `worker` service kind that runs Cloudflare Workers locally with Wrangler's Miniflare. Every config of a service runs in one process, so a producer Worker's Queue reaches a consumer Worker, service bindings connect them, and Durable Objects, R2, KV and Workflows persist in the environment's data directory. Each Worker's bindings come from the manifest, with `addressOf` to reach another target's running service such as the database, and never from the shell's environment. Wrangler is an optional peer dependency resolved from the target.
