# Versioning and releases

Wooble versions the self-hosted application as a whole using [Semantic Versioning](https://semver.org/). Git tags and release notes identify application releases. The workspace packages are private implementation units; their current `0.1.0` fields are not independent package release promises.

## First public release

The first public release is **[`v0.1.0`](https://github.com/Dityath/Wooble/releases/tag/v0.1.0)**, labeled as a preview. The repository is usable for local and trusted-group self-hosting, but product workflows and the public installation story are still developing. A `0.y.z` version communicates that compatibility may change during initial development.

Tag subsequent releases only after CI passes, installation from a fresh clone is checked, and release notes describe known limits. Subsequent pre-1.0 releases can use `v0.2.0`, `v0.3.0`, and so on for meaningful feature sets; use a patch version for fixes to a released line. Record database and configuration changes in each release note.

The initial `v0.2.0`–`v0.6.0` target dates and criteria of done are tracked in the [product roadmap](roadmap.md). Targets may move with contributor capacity; a version is tagged only when its release criteria are met.

For each release, review the generated notes grouped by [`.github/release.yml`](../.github/release.yml), then use the [release description template](../.github/RELEASE_TEMPLATE.md) to add user-facing highlights, upgrade instructions, validation, and limitations. Generated categories depend on labels on the merged **pull requests**, so maintainers should label those PRs before creating the release. The Markdown template is copied into the release description manually; GitHub does not automatically insert that file.

## What `v1.0.0` should mean

`v1.0.0` is the first release for which Wooble commits to a documented, dependable core experience and upgrade path. The proposed release criteria are:

1. **Core workflow:** users can create and maintain architecture views, inspect and edit their model, and work with useful API/protobuf contracts and database relationships. Documentation and discussion support contribution between members, with clear access rules.
2. **Consistent interface:** primary journeys across the canvas, inspector, contract and database views, comments, and documentation have coherent patterns, accessible states, and browser validation.
3. **Self-hosting:** Docker installation works from a fresh clone with a documented Bun alternative; configuration, migrations, backups, restore, upgrades, health checks, and HTTPS proxying are tested and documented. The account flow has a safe answer for public access, including email verification and recovery or a clearly supported restricted-registration mode.
4. **Compatibility contract:** document which API behavior, configuration keys, database migrations, and exported data formats self-hosters can rely on. Upgrade tests cover at least the previous release, and breaking changes have an announced migration path.
5. **Release evidence:** CI is green on the public repository, relevant integration and browser journeys pass, known issues are published, and a maintainer has reviewed the release candidate.

The product direction in [What Wooble is](product.md) guides scope, but not every possible import or integration is required for `v1.0.0`. Final release criteria should be reviewed with contributors before the first release candidate.

## After `v1.0.0`

Use `MAJOR.MINOR.PATCH` for the documented public compatibility contract: major for incompatible changes, minor for compatible additions, patch for compatible fixes. Publish release notes for each tag. For a candidate, use `v1.0.0-rc.1`, then `v1.0.0-rc.2` if needed, and finally `v1.0.0`. The suffix `-stable` would make `1.0.0-stable` a SemVer pre-release that sorts *before* `1.0.0`; use the plain `v1.0.0` tag for the stable release.
