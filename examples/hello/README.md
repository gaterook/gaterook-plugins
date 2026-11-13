# Hello: the smallest connector module

A complete [connector module](../../docs/module-architecture.md) in two classes. It adds one connector type, `hello`, with a read (`hello_greet`) and a change (`hello_note`, which adds a line to a notes file in the module's own data folder after a person approved exactly that line).

| File | What |
| --- | --- |
| [`module.json`](module.json) | The module's descriptor: id, version, entry point, the GateRook versions it runs with, what it reaches, its host's limits. |
| [`pom.xml`](pom.xml) | The build. It inherits nothing: copy this folder to start a module of your own. |
| [`HelloModule.java`](src/main/java/com/example/hello/HelloModule.java) | The entry point: it gives the module host the connectors. |
| [`HelloConnector.java`](src/main/java/com/example/hello/HelloConnector.java) | The connector type: its form, its tools, and how it judges, describes and runs a call. |
| [`HelloConnectorTest.java`](src/test/java/com/example/hello/HelloConnectorTest.java) | Tests of the connector, and of the manifest the build writes. |

## Build it

Install the application's artifacts once, as the [README](../../README.md#build-a-module) of this repository says. Then:

```bash
mvn -B -ntp verify
```

The package is `target/hello-1.0.0.jar`.

## Try it

In GateRook, open **Connectors → Add connector → Install plugin or module** and choose the JAR. GateRook didn't sign it, so the review asks you to confirm that you trust it. Then add a **Hello** connection, add it to an endpoint and call `hello_greet` from an AI app: the call waits for your approval, as every tool of a module of your own does at first.

## Make it yours

1. Rename the package, the classes, `id`, `name` and `moduleClass` in `module.json`, and the artifact in `pom.xml`.
2. Give your tools a prefix of your own in place of `hello_`.
3. Describe your connection in the connection form, with a `writeOnly` property for each secret.
4. Declare where the module goes in `access` of `module.json`.
5. Keep the version in `module.json` and in `pom.xml` equal, and raise it whenever the package changes.
