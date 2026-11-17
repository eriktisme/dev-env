# Changesets

A change a user of the package would notice adds a changeset in the same pull request: run `npm run changeset`, pick the bump, and describe the change for the changelog.
The release workflow opens a pull request that applies the pending changesets to the version and `CHANGELOG.md`.
Merging it publishes the new version to npm.
