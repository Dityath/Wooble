# Versioning and releases

Wooble versions the self-hosted application as a whole using [Semantic Versioning](https://semver.org/). Git tags and release notes identify application releases. The workspace packages are private implementation units; their current `0.1.0` fields are not independent package release promises.

## First public release

The first public release is **[`v0.1.0`](https://github.com/Dityath/Wooble/releases/tag/v0.1.0)**, labeled as a preview. The repository is usable for local and trusted-group self-hosting, but product workflows and the public installation story are still developing. A `0.y.z` version communicates that compatibility may change during initial development.

Tag subsequent releases only after CI passes, installation from a fresh clone is checked, and release notes describe known limits. Subsequent pre-1.0 releases can use `v0.2.0`, `v0.3.0`, and so on for meaningful feature sets; use a patch version for fixes to a released line. Record database and configuration changes in each release note.

The initial `v0.2.0`–`v0.6.0` target dates and criteria of done are tracked in the [product roadmap](roadmap.md). Targets may move with contributor capacity; a version is tagged only when its release criteria are met.

## Self-hosted image tags and release workflow

Self-hosted installs use one exact version for the API and web images, for example `v0.2.0` after that release exists. Compose requires `WOOBLE_VERSION`; never configure an install to follow `main`, `latest`, or a floating tag. The existing `v0.1.0` source predates the self-host CLI/access overlays and is a legacy upgrade fixture only. Before relying on a new tag, confirm both `ghcr.io/dityath/wooble-api:<tag>` and `ghcr.io/dityath/wooble-web:<tag>` exist. The Git tag alone does not prove images were published.

`.github/workflows/release.yml` is configured for `vMAJOR.MINOR.PATCH` tag pushes and manual dry runs. A tag push runs CI, then builds and smoke-tests each image on separate `linux/amd64` and `linux/arm64` matrix jobs, including a v0.1.0 source bootstrap and same-volume migration fixture. Only after those jobs succeed does the tag path publish exact-version API/web images and create a draft release. Manual dispatch requires the version input in the same exact form, including the `v` prefix; for example, enter `v0.2.0`. The manual path does not publish or create a release. This workflow is present in source but has not been run on GitHub; report the actual Actions run separately when one exists. Its smoke checks do not replace the Caddy browser login journey in the Self-hosted stack workflow.

The initial GHCR package visibility is a maintainer setup step. After the first authorized package publication, open the repository's **Packages** page, open each `wooble-api` and `wooble-web` package, then use **Package settings → Change visibility → Public** and confirm the change. Do this once for each package. This repository change does not change package visibility, and no package has been published as part of this delivery. Verify anonymous pulls after a maintainer changes visibility.

The release images pin their Bun and Caddy base images by immutable multi-platform index digest in `deploy/Dockerfile`. The API image runs as the unprivileged `bun` user. Both image variants include `THIRD_PARTY_NOTICES.txt`; review that generated notice file when dependencies change. A release workflow's matrix/build configuration is not evidence of successful `linux/amd64` and `linux/arm64` execution. Record the architectures actually tested by the hosted runner; if only one is available locally, state that limit.

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
