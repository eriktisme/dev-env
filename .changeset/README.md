# Changesets

If a user of the package would notice your change, add a changeset in the same pull request.
Run `npm run changeset`, pick the bump, and write a line for the changelog.

The release workflow then opens a pull request that bumps the version and updates `CHANGELOG.md`.
Merging it publishes to npm.
