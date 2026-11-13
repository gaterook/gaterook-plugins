# Connector modules

This folder holds two things.

## The list

`index.json` and `index.json.sig` are the list of GateRook's own connector modules. The release tooling writes them: never edit them by hand.

A release of GateRook reads the list from `https://raw.githubusercontent.com/gaterook/gaterook-plugins/main/modules/` and trusts it only under the key `modules-2026-1` of [`keys.json`](../keys.json).

An entry names one version of one module: the application versions it runs with, its package's address, size and SHA-256, and the connector types it adds. See [connector delivery](https://github.com/gaterook/gaterook/blob/main/docs/connector-delivery.md).

## The sources

Each folder is a connector module: its descriptor (`module.json`), its build (`pom.xml`), its code and its tests. [How a connector module is built](../docs/module-architecture.md) describes them, and the [README](../README.md#build-a-module) says how to build them.

| Folder | Connector |
| --- | --- |
| [`clickhouse`](clickhouse) | [ClickHouse](../docs/clickhouse.md) |
| [`duckdb`](duckdb) | [DuckDB](../docs/duckdb.md) |
| [`h2`](h2) | [H2](../docs/h2.md) |
| [`msaccess`](msaccess) | [Microsoft Access](../docs/access.md) |

`modules.lock.json` records the size and SHA-256 of every released version of these modules. The release tooling writes it; `node tools/modules.mjs status` compares a build with it.

The list also holds modules whose source is in the [application repository](https://github.com/gaterook/gaterook), because they are built from its connector code: Apache Cassandra, Neo4j, Oracle Database and SQL Server.
