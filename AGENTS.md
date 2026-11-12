# Working on this repository

This repository distributes signed lists and released packages for GateRook. It holds no source code.

## Language

All content is English only: documentation, comments, commit messages, pull request text and release notes. Chat replies may follow the user's language.

## Rules

- Never edit `modules/index.json`, `catalog/index.json` or their `.sig` files by hand. The release tooling writes them, and the signature covers their exact bytes.
- Never commit a private key, a signing seed or any credential. `keys.json` holds public keys only.
- Never change or delete a released package. A fix is a new version; a bad package is revoked in its list.
- Do not add build scripts, sources or release orchestration here. Packages are built from the application repository.
- Do not publish a list, create a release or push without an explicit request.
- Put scratch files under the repository-root `ai/` directory. It is ignored; never commit it.

## Before you finish

Run `node tools/check.mjs` and `node --test tools/check.test.mjs`. Check the staged paths before every commit.
