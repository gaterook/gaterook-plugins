# Control AI access to a ClickHouse database

GateRook's MCP Firewall lets AI apps run bounded, read-only analytics queries on ClickHouse over its HTTP interface. The connector never changes data. The [security model](https://github.com/gaterook/gaterook/blob/main/docs/security.md) explains execution controls and the append-only, tamper-evident audit trail.

## Get the ClickHouse connector

ClickHouse is one of GateRook's own connectors, delivered as a [connector module](https://github.com/gaterook/gaterook/blob/main/docs/connector-delivery.md#connector-modules): it isn't part of the installer. The first time you choose ClickHouse in **Add connection**, GateRook downloads its package (about 60 KB), checks it against its signed list of modules and starts using it; there is nothing to review or confirm, and later versions arrive the same way. The connector's code runs in a module host, a separate Java process with its own data folder, started by GateRook. The package holds the connector alone: it brings no library and sends its requests through the module host's guarded HTTP client.

To build the package yourself, install the application's artifacts as [the README](../README.md#build-a-module) says; `mvn -B -ntp -pl modules/clickhouse package -DskipTests` then writes `modules/clickhouse/target/clickhouse-1.0.0.jar`. The build is reproducible. **Connectors → Add connector → Install plugin or module** takes the file: a package that GateRook's signed list has installs as GateRook's own connector, and any other build is [your own module](https://github.com/gaterook/gaterook/blob/main/docs/connector-delivery.md#a-module-from-a-file), reviewed as unsigned code, whose tools all start in **Approval**.

On an endpoint all six tools start in **Read only**.

## Connect to a ClickHouse server

A connection is one ClickHouse server or ClickHouse Cloud service:

- the **host**, and the **port** of its HTTP interface: 8443 with TLS (ClickHouse Cloud), 8123 without. The connector may reach only these two ports of the connection's host;
- the **database** queries run in when they name none, and optionally the **databases** selected for the connection;
- the **user** and its **password**, which GateRook stores encrypted and hands the connector for one call at a time; leave the password empty for a user without one, such as the default user of a local server.

**TLS** is on by default. Without TLS the connector reaches only a private address that the connection's environment allows in its policy (`http.allowedPrivateRanges`); **Test connection** then names the range to allow. Cloud metadata, link-local addresses and GateRook's own ports are never reachable, and redirects aren't followed.

**Test connection** runs one query, reports the ClickHouse version and the user, checks each selected database and reads the user's grants. A user that may also write (`INSERT`, `ALTER`, `DROP` and the like) gets a warning: the connector sends `readonly=1` with every query, but a user that can only read is the better guard for prod. A user whose own profile sets `readonly=1` can't be used, because that setting also forbids the limits GateRook sends with every query; the test says so. Give such a user `readonly=2`: it may read and set limits, and never write.

```sql
CREATE USER agent IDENTIFIED BY 'choose-a-password' SETTINGS readonly = 2;
GRANT SELECT ON analytics.* TO agent;
```

## Bound reads

| Tool | What it does |
| --- | --- |
| `clickhouse_query` | One read-only query: SELECT, WITH … SELECT, SHOW, DESCRIBE, EXPLAIN or EXISTS |
| `clickhouse_list_databases` | The databases the user can see, with their engines and table counts |
| `clickhouse_list_tables` | The tables of one database: engine, rows, size on disk and comment, largest first |
| `clickhouse_describe_table` | One table's columns with types, defaults and comments, its engine, sorting key, partition key and size |
| `clickhouse_explain` | How ClickHouse would run a SELECT, without running it: the plan, the pipeline, an estimate, or the rewritten query |
| `clickhouse_running_queries` | The queries running on the server now, with the query text cut to 300 characters |

Two things keep a query from changing anything. Before a statement leaves the connector, GateRook reads it the way ClickHouse's lexer does (strings with backslash escapes and doubled quotes, heredoc strings, quoted identifiers, `--`, `#` and block comments) and refuses whatever isn't one read: a statement that starts with anything but the words above, more than one statement, `INTO OUTFILE`, and every table function that reaches another system, the server's files or a process (`url`, `s3`, `remote`, `file`, `mysql`, `postgresql`, `executable` and the others). It refuses what it can't read with certainty, such as an unterminated string. And ClickHouse itself runs every query with `readonly=1` and `allow_ddl=0`, which refuse writes, DDL and changes of settings on the server's side.

A connection with selected databases is held to them: a query is a SELECT, WITH … SELECT or EXPLAIN whose tables are in a selected database, dictionary and join lookups are refused because they can't be limited to those databases, and `clickhouse_running_queries`, which is server-wide, isn't available.

Every query carries `max_execution_time` (the connection's **Max execution time**, 30 seconds by default) and `max_result_rows` with `result_overflow_mode=break`, so a large result is cut rather than refused. The row limit is the smallest of the call's `limit` (100 when it gives none), the connection's **Max rows** (1,000 by default) and the environment's limit. Values the connector adds to a statement go as query parameters, never pasted into SQL. An answer larger than 8 MB is refused.

ClickHouse's own refusal of a query (a syntax error, an unknown table, a missing privilege, the time limit) is a result the agent reads. Trouble reaching the server is an error GateRook counts against the connection.

## Verify

The module's tests run against a stand-in for ClickHouse's HTTP interface in the test JVM: the tools, the settings every query carries, limits, the classifier's refusals, what a test says about a reader and a writer, and the setup suggestions. `ClickHouseModuleHostIT` loads the built package in a real module host (on macOS under the core's `sandbox-exec` rules) and checks that the connector gets its password through the secret callback, reaches the server only on the port the call's grant names, and sends nothing for a statement that would change data. `ClickHouseModuleCoreProcessIT` (in the [application repository](https://github.com/gaterook/gaterook)) has the assembled core install the package from a list of modules and run a query through it once the policy allows the server's address.

```bash
mvn -B -ntp -pl modules/clickhouse verify
```

These tests use no real ClickHouse server, so they don't establish behaviour against a particular ClickHouse version or ClickHouse Cloud.
