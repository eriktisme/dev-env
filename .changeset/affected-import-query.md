---
'@evandam93/dev-env': patch
---

`dev-env affected` now runs a spec when a file it imports with a query, such as Vite's `?raw`, changes. Before, the query made the path match no file, so the change ran nothing.
