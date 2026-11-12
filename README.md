# GateRook plugins and connector modules

This repository is where [GateRook](https://gaterook.com) downloads optional code from: its own connector modules and the plugins of its catalog. It holds signed lists and released packages. It holds no source code: the connectors and plugins are built from the [application repository](https://github.com/gaterook/gaterook).

## What is here

| Path | What |
| --- | --- |
| `modules/index.json`, `modules/index.json.sig` | The list of GateRook's own connector modules: the connectors that aren't part of the installer and arrive when a connection needs them. |
| `catalog/index.json`, `catalog/index.json.sig` | The plugin catalog: plugins, templates and MCP servers that a person chooses and reviews in Connectors › Catalog. |
| [Releases](https://github.com/gaterook/gaterook-plugins/releases) | The packages. One release per package version, tagged `module-<id>-<version>` or `plugin-<id>-<version>`, with the JAR as its asset. |
| `keys.json` | The public halves of the keys the lists are signed with, by key id. |
| `tools/check.mjs` | Checks the lists in this repository. It runs on every push and pull request. |

No list has been published yet. The folders are ready for the first one.

## How GateRook uses a list

GateRook trusts nothing because it is in this repository. It trusts a list only by its signature:

1. It downloads `index.json` and `index.json.sig` over HTTPS.
2. It verifies the Ed25519 signature over the exact bytes of `index.json`, with a public key that is built into the application. A list signed with another key is refused.
3. It refuses a list whose `sequence` is lower than the highest one it has accepted, so an old list can't be replayed.
4. It installs nothing from a list after its `expiresAt`.
5. It downloads a package from the address the list gives and refuses it unless its size and SHA-256 are the ones the list pins. A package named in `revoked` is refused and, when it is installed, switched off.

The two lists are signed with different keys, because they vouch for different things. A connector module is GateRook's own code and installs without a review. A catalog plugin is code a person reviews before it loads.

The formats are described with the application: [connector delivery](https://github.com/gaterook/gaterook/blob/main/docs/connector-delivery.md) for modules and the [catalog notes](https://github.com/gaterook/gaterook/blob/main/catalog/README.md) for plugins.

## Rules for changes

- **A list is written by the release tooling, never by hand.** The signature covers every byte of `index.json`: an edit, a reformat or a changed line ending breaks it. `.gitattributes` keeps Git from touching the bytes.
- **`sequence` grows with every published list**, and `expiresAt` is at most 90 days after `generatedAt`. A new list is published before the last one expires.
- **A released package never changes.** A fix is a new version with a new release. A bad package is revoked in the list; its release stays, so the revocation can be checked.
- **Package addresses are `https://` addresses of this repository's releases.**
- **No private key is ever committed.** `keys.json` holds public keys only.

Run the check before you push:

```bash
node tools/check.mjs
```

```bash
node --test tools/check.test.mjs
```

## Problems

Write to [support@gaterook.com](mailto:support@gaterook.com). For a problem with the application, use the [application repository](https://github.com/gaterook/gaterook/issues).
