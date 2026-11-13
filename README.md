# GateRook plugins and connector modules

This repository is where [GateRook](https://gaterook.com) downloads optional code from, and where the connector modules that are built against the connector API alone have their source. It holds:

- the signed lists GateRook reads, and the released packages they pin;
- the source of connector modules: ClickHouse, DuckDB, H2 and Microsoft Access;
- [how a connector module is built](docs/module-architecture.md), for anyone who writes one, with the smallest module as an example.

The application itself, its connector API and its other connectors are in the [application repository](https://github.com/gaterook/gaterook).

## What is here

| Path | What |
| --- | --- |
| `modules/index.json`, `modules/index.json.sig` | The list of GateRook's own connector modules: the connectors that aren't part of the installer and arrive when a connection needs them. |
| `modules/<id>/` | The source of a connector module: its descriptor (`module.json`), its build, its code and its tests. |
| `modules/modules.lock.json` | The size and SHA-256 of every released version of those modules. |
| `examples/hello/` | The smallest connector module, with a build that stands on its own. |
| `docs/` | The [module architecture](docs/module-architecture.md), and what each connector does: [ClickHouse](docs/clickhouse.md), [DuckDB](docs/duckdb.md), [H2](docs/h2.md), [Microsoft Access](docs/access.md). |
| `catalog/index.json`, `catalog/index.json.sig` | The plugin catalog: plugins, templates and MCP servers that a person chooses and reviews in Connectors › Catalog. |
| [Releases](https://github.com/gaterook/gaterook-plugins/releases) | The packages. One release per package version, tagged `module-<id>-<version>` or `plugin-<id>-<version>`, with the JAR as its asset. |
| `keys.json` | The public halves of the keys the lists are signed with, by key id. |
| `pom.xml` | The build of the modules. |
| `tools/` | Checks of the lists (`check.mjs`) and of the modules' versions and packages (`modules.mjs`). They run on every push and pull request. |

The list of connector modules is published. The plugin catalog is not published yet: its folder is ready for the first one.

## Connector modules

| Module | Connector | Source |
| --- | --- | --- |
| `clickhouse` | [ClickHouse](docs/clickhouse.md) over its HTTP interface | [`modules/clickhouse`](modules/clickhouse) |
| `duckdb` | [DuckDB](docs/duckdb.md) database files | [`modules/duckdb`](modules/duckdb) |
| `h2` | [H2](docs/h2.md) database servers | [`modules/h2`](modules/h2) |
| `msaccess` | [Microsoft Access](docs/access.md) files | [`modules/msaccess`](modules/msaccess) |
| `cassandra`, `neo4j`, `sql-oracle`, `sql-sqlserver` | Apache Cassandra, Neo4j, Oracle Database, SQL Server | [Application repository](https://github.com/gaterook/gaterook): they are built from its connector code |

Every module of the list is released here, whichever repository builds it.

## How GateRook uses a list

GateRook trusts nothing because it is in this repository. It trusts a list only by its signature:

1. It downloads `index.json` and `index.json.sig` over HTTPS.
2. It verifies the Ed25519 signature over the exact bytes of `index.json`, with a public key that is built into the application. A list signed with another key is refused.
3. It refuses a list whose `sequence` is lower than the highest one it has accepted, so an old list can't be replayed.
4. It installs nothing from a list after its `expiresAt`.
5. It downloads a package from the address the list gives and refuses it unless its size and SHA-256 are the ones the list pins. A package named in `revoked` is refused and, when it is installed, switched off.

The two lists are signed with different keys, because they vouch for different things. A connector module is GateRook's own code and installs without a review. A catalog plugin is code a person reviews before it loads.

The source in this repository is not what GateRook trusts either: an installed application takes only packages the signed list pins. A module built from this source by anybody else is [their own module](docs/module-architecture.md#gaterooks-modules-and-yours), installed from a file after a review.

The formats are described with the application: [connector delivery](https://github.com/gaterook/gaterook/blob/main/docs/connector-delivery.md) for modules and the [catalog notes](https://github.com/gaterook/gaterook/blob/main/catalog/README.md) for plugins.

## Build a module

You need JDK 25, Maven 3.9 or later and Node.js 22 or later.

A module is built against three artifacts of the application: `connector-api`, `plugin-protocol` and `plugin-host`. Build them once from the application repository; `mvn install` puts them into your local Maven repository:

```bash
git clone https://github.com/gaterook/gaterook.git
```

```bash
mvn -B -ntp -f gaterook/pom.xml -pl plugin-host -am install -DskipTests
```

The application revision must provide the versions this repository's [`pom.xml`](pom.xml) names as `gaterook.version` and `connector-api.version`.

Then, in this repository, build every module and run its tests:

```bash
mvn -B -ntp verify
```

One module alone, without its tests:

```bash
mvn -B -ntp -pl modules/h2 package -DskipTests
```

The package is `modules/<id>/target/<id>-<version>.jar`. The build is reproducible: the same sources, built with the same JDK against the same application artifacts, give the same bytes. This command says whether each built package is the released one:

```bash
node tools/modules.mjs status
```

`released` means the package has the SHA-256 that `modules/modules.lock.json` records for its version, which is the one the signed list pins. `new` is a version that was never released, and `changed` is a released version built with other bytes.

To use a package you built, choose it in GateRook under **Connectors → Add connector → Install plugin or module**. A package with the released bytes installs as GateRook's own; any other is your own module.

## Write your own module

[How a connector module is built](docs/module-architecture.md) describes the parts, the package, the code, what a module may reach and how GateRook treats a module it didn't sign. [`examples/hello`](examples/hello) is a complete module in two classes. Its build inherits nothing, so the folder can be copied out of this repository:

```bash
mvn -B -ntp -f examples/hello/pom.xml verify
```

## Rules for changes

- **A list is written by the release tooling, never by hand.** The signature covers every byte of `index.json`: an edit, a reformat or a changed line ending breaks it. `.gitattributes` keeps Git from touching the bytes.
- **`sequence` grows with every published list**, and `expiresAt` is at most 90 days after `generatedAt`. A new list is published before the last one expires.
- **A released package never changes.** A fix is a new version with a new release. A bad package is revoked in the list; its release stays, so the revocation can be checked.
- **A module's version changes when its package does.** A change to a module's sources that changes its package's bytes needs a new version before it can be released: `node tools/modules.mjs bump <id>` writes it to `module.json` and the module's `pom.xml`. A change that leaves the bytes as they are, such as a test or a comment, needs none.
- **`modules/modules.lock.json` is written by the release tooling**, when a version is released.
- **Package addresses are `https://` addresses of this repository's releases.**
- **No private key is ever committed.** `keys.json` holds public keys only.

Run the checks before you push:

```bash
node tools/check.mjs
```

```bash
node tools/modules.mjs check
```

```bash
node --test tools/check.test.mjs tools/modules.test.mjs
```

## License

The source in this repository is licensed under the [Apache License, Version 2.0](LICENSE). The libraries a package bundles keep their own licenses and notices, which the package carries.

## Problems

Write to [support@gaterook.com](mailto:support@gaterook.com). For a problem with the application, use the [application repository](https://github.com/gaterook/gaterook/issues).
