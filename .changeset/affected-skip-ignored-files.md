---
'@evandam93/dev-env': patch
---

`dev-env affected` and `graphOf` now read only the code git sees under a process's `sources`, tracked or new, and skip what git ignores, such as build output. Before, a build that rewrote its output while the selection read it could fail the selection with ENOENT, and a file deleted while it ran is now read as reaching nothing.
