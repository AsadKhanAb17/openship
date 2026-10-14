# TODO: Separate the app catalog listing from app packages

Status: deferred at the user's request. No runtime implementation or release change has been made.

## Purpose

Keep `catalog.json` as a lightweight directory of apps. Each app should own its complete installation definition, setup scripts, configuration files, and documentation. Avoid maintaining shell/JavaScript scripts as large escaped JSON strings.

Today, individual `apps/catalog/<id>.json` files are the authoring source, but `gen-catalog.ts` copies every complete definition and its embedded files into one generated `apps/catalog.json`. Several dashboard components also read full bundled templates directly. This task must address both authoring and consumption; moving files alone will not make listing requests or browser bundles smaller.

## Intended structure

```text
packages/core/src/apps/
  catalog.json                  # Generated listing metadata and package references
  catalog/
    wordpress/
      app.json                  # Installation definition
      files/
        entrypoint.sh           # Setup/runtime files, authored normally
      article.md
    immich/
      app.json
      files/
        setup.cjs
      article.md
```

The final generated package location and filenames should be decided during implementation. Published package references must identify immutable content, rather than resolving arbitrary files from a changing branch.

## Work to complete

- [ ] Move every curated app into its own directory, preserving its current behavior.
- [ ] Extract mounted files, Dockerfiles, and substantial bootstrap scripts into real files. Add explicit authoring references and resolve them during packaging. Keep commands/entrypoint argv as declarative installation configuration.
- [ ] Restrict `catalog.json` to listing metadata: ID, name, icon, short description, category/tags, availability/trust/hosting flags, compatibility, optional sizing guidance, and a package reference. Keep services, setup code, settings, credentials configuration, and articles in the app package.
- [ ] Keep one validation/packaging pipeline. Resolve file references inside the owning app directory; reject traversal, escaping symlinks, missing files, ambiguous inline/file values, duplicate IDs, and invalid service references.
- [ ] Generate independently loadable app packages with revision/hash references. Validate package content and identity before use. Listing and installation must not accidentally mix different package revisions.
- [ ] Store curated ordering explicitly; stop deriving it from the previous generated full catalog.
- [ ] Update the API loader to refresh/cache the small index and fetch full definitions only when needed. Deduplicate concurrent reads and preserve a last-good/bundled fallback for offline desktop/server operation.
- [ ] Separate lightweight metadata/helpers from full bundled templates. Review dashboard install/settings/source-app pickers and the local service catalog so imports do not pull all setup scripts into browser bundles or bypass the authoritative API template.
- [ ] Update the website: use the listing for grids and load the selected app's documentation/details separately.
- [ ] Preserve organization scoping, custom-app validation, and curated-ID protection. User uploads must not gain arbitrary filesystem/network access through package references.
- [ ] Update install, deploy, settings, connection, webmail, catalog-image checks, smoke tests, and any SDK/CLI contracts affected by the new loading model.

## Compatibility and announcement

The user accepts requiring an updated API for the new catalog format. This is not authorization to break running apps or lose configuration/data.

- [ ] Choose the actual minimum API version when implementation lands; do not promise a release number prematurely.
- [ ] Version the index protocol separately from individual installation definitions.
- [ ] Verify how existing released loaders interpret the new index. Do not let a metadata-only entry be treated as a complete installable template.
- [ ] Make unsupported versions retain their usable bundled catalog or show a clear upgrade-required state. If the old loader cannot show that state safely, keep its URL compatible or publish the new index at a separate URL.
- [ ] Add release notes and documentation stating which API version is required for current catalog installs. Desktop users connected to a remote instance must update that instance's API too.
- [ ] Preserve existing projects, secrets, persistent volumes, redeployment, and supported day-two management.

## Required verification before a PR is ready

- [ ] Generator drift/schema checks and exact before/after equivalence of compiled definitions, including script bytes.
- [ ] File-boundary and hash/identity validation; missing/tampered packages and unsupported formats.
- [ ] Lazy loading, request deduplication, refresh failure, offline fallback, and package/index consistency during updates.
- [ ] Curated/custom app resolution and organization authorization.
- [ ] API, dashboard, website, SDK/CLI, and compiled desktop packaging/type checks.
- [ ] Representative real installs and redeployments, including a setup script, a mounted config file, an inline build, a multi-service app, and the webmail flow. Confirm persistent data and changed credentials survive.
- [ ] Review and publish a PR when this task is resumed; do not merge or deploy as part of recording this TODO.
