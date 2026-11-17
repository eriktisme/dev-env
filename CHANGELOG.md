# @evandam93/dev-env

## 0.1.1

### Patch Changes

- [#1](https://github.com/eriktisme/dev-env/pull/1) [`dc91c00`](https://github.com/eriktisme/dev-env/commit/dc91c00d3aac8fd3bccab3c0b791747bad16fe7b) Thanks [@eriktisme](https://github.com/eriktisme)! - `dev-env affected` now runs a spec when a file it imports with a query, such as Vite's `?raw`, changes. Before, the query made the path match no file, so the change ran nothing.
