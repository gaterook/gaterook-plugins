# Working on this repository

This repository distributes signed lists and released packages for GateRook, and holds the source of the connector modules that are built against the connector API alone, with the documents that describe how a module is built.

## Language

All content is English only: documentation, code comments, commit messages, pull request text and release notes. Chat replies may follow the user's language.

## Before making changes

Read `README.md` and, for module work, `docs/module-architecture.md`. Check the working tree and the branch, and preserve existing changes.

## Lists and releases

- Never edit `modules/index.json`, `catalog/index.json`, their `.sig` files or `modules/modules.lock.json` by hand. The release tooling writes them, and a signature covers the exact bytes of its list.
- Never commit a private key, a signing seed or any credential. `keys.json` holds public keys only.
- Never change or delete a released package. A fix is a new version; a bad package is revoked in its list.
- Do not publish a list, create a release or push without an explicit request.
- Do not add release orchestration here: signing and publishing are not part of this repository.

## Module sources

- A module is `modules/<id>/`: `module.json`, `pom.xml`, `src/`. The root `pom.xml` builds them all; it inherits from no other build and pins what decides a package's bytes.
- A package's bytes are a contract: `modules/modules.lock.json` records the SHA-256 of every released version, and the signed list pins it. Build first, then run `node tools/modules.mjs status`. A module that shows `changed` needs a new version (`node tools/modules.mjs bump <id>`) before it can be released; never rebuild a released version into other bytes on purpose.
- Everything under `src/main`, `module.json` and the module's `pom.xml` can change the package. In Java sources that includes comments that add or remove lines, because the classes carry line numbers. Tests and documents change nothing of a package.
- A module compiles against `connector-api` and Jackson with the `provided` scope and ships neither. It uses nothing else of the application: do not add a dependency on another application artifact to a module.
- Keep the third-party license and notice files a package bundles, and the note that says which is whose.
- `examples/hello` must stay the smallest working module, with a build that inherits nothing.
- Put scratch files under the repository-root `ai/` directory. It is ignored; never commit it.

## Verification

Run the checks relevant to the change and report the ones you ran:

- `node tools/check.mjs` and `node tools/modules.mjs check` need neither a build nor Java.
- `node --test tools/check.test.mjs tools/modules.test.mjs`.
- `mvn -B -ntp verify` builds every module and runs its tests, including the tests that load a built package in a real module host. It needs the application's artifacts in the local Maven repository (`README.md`, "Build a module").
- `node tools/modules.mjs status` after a build.

Check the staged paths before every commit.
