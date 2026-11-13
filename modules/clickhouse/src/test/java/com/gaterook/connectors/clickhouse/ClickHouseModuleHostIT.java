package com.gaterook.connectors.clickhouse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gaterook.connector.api.ApiVersion;
import com.gaterook.connector.api.ConnectionConfig;
import com.gaterook.connector.api.Env;
import com.gaterook.connector.api.Limits;
import com.gaterook.connector.api.ToolCall;
import com.gaterook.connector.api.ToolDefinition;
import com.gaterook.connector.api.ToolResult;
import com.gaterook.plugin.protocol.Gpp;
import com.gaterook.plugin.protocol.GppJson;
import com.gaterook.plugin.protocol.JsonRpcPeer;
import com.gaterook.plugin.protocol.Messages;
import com.gaterook.plugin.protocol.PluginManifest;
import com.gaterook.plugin.protocol.RpcException;
import com.gaterook.plugin.protocol.SecretWire;
import com.gaterook.plugin.protocol.WireCodec;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import mockwebserver3.Dispatcher;
import mockwebserver3.MockResponse;
import mockwebserver3.MockWebServer;
import mockwebserver3.RecordedRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The release JAR in a real module host, spawned as the core spawns one (docs/module-architecture.md), against a fake
 * ClickHouse HTTP interface in this JVM. The host loads the package as it is released and reports the tools its
 * manifest declares; the connector reads its password through the secret callback, reaches the server only on the
 * port the call's grant names, and the password leaves no trace in the result. A statement that would change data is
 * refused inside the connector, before anything is sent. On macOS the host runs under {@code sandbox-exec} with the
 * core's rules for files.
 */
class ClickHouseModuleHostIT {

  private static final String GENERATION = "clickhouse@2.0.0";
  private static final List<Integer> CORE_PORTS = List.of(7465, 7466);
  private static final Limits DEV = new Limits(1000, 1000, 524_288, 1_048_576, 262_144, 65_536, 8192,
      Duration.ofSeconds(5), Duration.ofSeconds(30), Duration.ofSeconds(10), Duration.ofHours(168));

  @TempDir
  Path temp;

  private Path home;
  private Path dataDir;
  private MockWebServer server;
  private Process process;
  private JsonRpcPeer peer;
  private volatile String password = "cnry-ch-pass-31f0";
  private final List<String> stderr = new CopyOnWriteArrayList<>();

  @BeforeEach
  void setUp() throws Exception {
    Path jar = jar();
    Assumptions.assumeTrue(Files.isRegularFile(jar), "the release JAR is built by package: " + jar);
    home = Files.createDirectories(temp.resolve("gaterook-home")).toRealPath();
    dataDir = Files.createDirectories(home.resolve("plugin-data").resolve("clickhouse").resolve("tmp")).getParent();
  }

  @AfterEach
  void stop() throws Exception {
    if (peer != null) {
      try {
        peer.request(Gpp.HOST_SHUTDOWN, GppJson.object().put("graceMs", 500)).get(Duration.ofSeconds(3));
      } catch (Exception e) {
        // It may already be gone.
      }
      peer.close();
    }
    if (process != null) {
      process.descendants().forEach(ProcessHandle::destroyForcibly);
      process.destroyForcibly();
    }
    if (server != null) {
      server.close();
    }
  }

  @Test
  void theHostLoadsThePackageWithTheToolsItsManifestDeclares() throws Exception {
    serve("{\"meta\":[],\"data\":[],\"rows\":0}");
    Messages.Loaded loaded = start();
    assertThat(loaded.types()).extracting(Messages.TypeTools::type).containsExactly("clickhouse");
    assertThat(hashes(loaded.types().getFirst().tools()))
        .isEqualTo(PluginManifest.parse(TestCalls.manifest()).definitionHashesByType().get("clickhouse"));
  }

  @Test
  void aQueryRunsReadOnlyWithItsPasswordFromTheCore() throws Exception {
    serve("{\"meta\":[{\"name\":\"event\",\"type\":\"String\"},{\"name\":\"n\",\"type\":\"UInt64\"}],"
        + "\"data\":[[\"click\",\"120\"]],\"rows\":1,\"statistics\":{\"elapsed\":0.002,\"rows_read\":120}}");
    start();

    JsonNode answer = execute(call("clickhouse_query",
        "{\"sql\":\"SELECT event, count() AS n FROM events GROUP BY event\"}"));
    ToolResult result = WireCodec.result(answer);
    assertThat(result.isError()).as(stderr.toString()).isFalse();
    assertThat(result.table().rows().get(0).get(0).asString()).isEqualTo("click");
    assertThat(answer.toString()).doesNotContain("cnry-ch-pass");
    RecordedRequest seen = server.takeRequest(2, TimeUnit.SECONDS);
    assertThat(seen.getTarget()).contains("readonly=1").contains("allow_ddl=0");
    assertThat(seen.getHeaders().get("X-ClickHouse-Key")).isEqualTo("cnry-ch-pass-31f0");

    // A statement that changes data never leaves the connector.
    assertThatThrownBy(() -> execute(call("clickhouse_query", "{\"sql\":\"DROP TABLE events\"}")))
        .hasMessageContaining("never changes data");
    assertThat(server.takeRequest(300, TimeUnit.MILLISECONDS)).isNull();
  }

  @Test
  void theDatabasesOfAServerAreListedForTheConnectionForm() throws Exception {
    serve("{\"meta\":[],\"data\":[[\"analytics\"],[\"archive\"]],\"rows\":2}");
    password = "cnry-ch-discovery-31f0";
    start();

    Messages.Test discover = new Messages.Test(GENERATION, "tt_1", "ct_discover", connection(), 10_000, DEV, grant());
    JsonNode result = await(peer.request(Gpp.CONNECTOR_DISCOVER_DATABASES, discover.write()), Duration.ofSeconds(15));
    assertThat(result.path("ok").asBoolean()).as(result + " " + stderr).isTrue();
    assertThat(result.path("details").path("databases")).extracting(JsonNode::asString)
        .containsExactly("analytics", "archive");
    assertThat(result.toString()).doesNotContain("cnry-ch-discovery");
    RecordedRequest seen = server.takeRequest(2, TimeUnit.SECONDS);
    assertThat(seen.getBody().utf8()).isEqualTo("SHOW DATABASES");
    assertThat(seen.getHeaders().get("X-ClickHouse-Key")).isEqualTo("cnry-ch-discovery-31f0");
  }

  @Test
  void aGrantForAnotherPortLetsNothingThrough() throws Exception {
    serve("{\"meta\":[],\"data\":[],\"rows\":0}");
    start();
    int other = server.getPort() == 65_535 ? 1 : server.getPort() + 1;
    Messages.EgressGrant elsewhere = new Messages.EgressGrant(List.of("127.0.0.1:" + other), List.of("127.0.0.0/8"),
        CORE_PORTS);

    ToolCall query = call("clickhouse_query", "{\"sql\":\"SELECT 1\"}");
    assertThatThrownBy(() -> execute(query, elsewhere)).isInstanceOf(IllegalStateException.class);
    assertThat(server.takeRequest(300, TimeUnit.MILLISECONDS)).as("nothing reached the server").isNull();
  }

  // ── The fake server ─────────────────────────────────────────────────────────────────────────────────────────

  private void serve(String body) throws Exception {
    server = new MockWebServer();
    server.setDispatcher(new Dispatcher() {
      @Override
      public MockResponse dispatch(RecordedRequest request) {
        return new MockResponse.Builder().code(200).addHeader("Content-Type", "application/json").body(body).build();
      }
    });
    server.start(InetAddress.getByName("127.0.0.1"), 0);
  }

  /** A connection to the fake server: plain HTTP on this computer, which the grant below allows. */
  private ConnectionConfig connection() {
    ObjectNode c = GppJson.object();
    c.put("host", "127.0.0.1");
    c.put("port", server.getPort());
    c.put("database", "analytics");
    c.put("user", "gw_reader");
    c.putObject("options").put("tls", false);
    return new ConnectionConfig("c_ch", "events-ch", "clickhouse", Env.DEV, 1, c, Set.of("/password"), null);
  }

  /** The fake server's port only, as the core grants a connection's host under a policy that allows this computer. */
  private Messages.EgressGrant grant() {
    return new Messages.EgressGrant(List.of("127.0.0.1:" + server.getPort()), List.of("127.0.0.0/8"), CORE_PORTS);
  }

  private static ToolCall call(String tool, String json) {
    return new ToolCall("tc_1", tool, "events-ch", (ObjectNode) GppJson.MAPPER.readTree(json), null);
  }

  // ── The host ────────────────────────────────────────────────────────────────────────────────────────────────

  private static Path jar() {
    return Path.of(System.getProperty("gateway.clickhouseJar", "target/clickhouse-2.0.0.jar"));
  }

  private static boolean mac() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("mac")
        && Files.isExecutable(Path.of("/usr/bin/sandbox-exec"));
  }

  private Messages.Loaded start() throws Exception {
    Path java = Path.of(System.getProperty("java.home"), "bin", "java");
    String hostJar = System.getProperty("gateway.pluginHostJar");
    Assumptions.assumeTrue(hostJar != null && Files.isRegularFile(Path.of(hostJar)), "plugin-host.jar is copied by "
        + "pre-integration-test");
    boolean sandbox = mac();
    List<String> argv = new ArrayList<>();
    if (sandbox) {
      argv.addAll(List.of("/usr/bin/sandbox-exec", "-p", macProfile()));
    }
    // The core's flags for a host, its heap and metaspace from the module's manifest.
    argv.addAll(List.of(java.toString(), "-Xlog:disable", "-Xlog:all=warning:stderr", "-XX:+UseSerialGC",
        "-XX:TieredStopAtLevel=1", "-Xms8m", "-Xmx128m", "-Xss512k", "-XX:ReservedCodeCacheSize=32m",
        "-XX:MaxMetaspaceSize=128m", "-XX:-UsePerfData", "-XX:+DisableAttachMechanism", "-XX:+ExitOnOutOfMemoryError",
        "--enable-native-access=ALL-UNNAMED", "-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8",
        "-Djava.io.tmpdir=" + dataDir.resolve("tmp"), "-cp", hostJar, "com.gaterook.pluginhost.Main",
        "--protocol", String.valueOf(Gpp.PROTOCOL)));
    ProcessBuilder pb = new ProcessBuilder(argv).directory(dataDir.toFile());
    pb.environment().clear();
    pb.environment().put("LANG", "C.UTF-8");
    pb.environment().put("TMPDIR", dataDir.resolve("tmp").toString());
    pb.environment().put("PATH", "/usr/bin:/bin");
    if (sandbox) {
      pb.environment().put("MCP_GATEWAY_SANDBOX", "sandbox-exec");
    }
    process = pb.start();
    Thread.ofVirtual().start(this::pumpStderr);
    peer = new JsonRpcPeer(process.getInputStream(), process.getOutputStream(), new JsonRpcPeer.Handler() {
      @Override
      public Object handle(String method, JsonNode params, JsonRpcPeer.Incoming call) throws RpcException {
        return switch (method) {
          case Gpp.SECRETS_GET -> {
            if (!"/password".equals(params.path("field").asString())) {
              throw new RpcException(Gpp.SECRET_DENIED, "no secret " + params.path("field").asString());
            }
            yield SecretWire.text(password.toCharArray(), "v1", null);
          }
          case Gpp.SECRETS_META -> {
            ObjectNode o = GppJson.object();
            o.put("set", "/password".equals(params.path("field").asString()));
            o.put("source", "local");
            o.put("version", "v1");
            yield o;
          }
          default -> throw new RpcException(Gpp.METHOD_NOT_FOUND, "No core method " + method + " in this test");
        };
      }
    }, JsonRpcPeer.Options.defaults().name("core").strayLine(line -> stderr.add("stdout: " + line))).start();
    await(peer.request(Gpp.HOST_HELLO, new Messages.Hello(Gpp.PROTOCOL, "0.9.2", ApiVersion.CURRENT, false,
        Gpp.MAX_FRAME_BYTES, 8, "info").write()), Duration.ofSeconds(30));
    Messages.Sandbox s = new Messages.Sandbox(sandbox, List.of(), List.of(dataDir.toString()));
    Path jar = jar().toAbsolutePath();
    Messages.Loaded loaded = Messages.Loaded.read(await(peer.request(Gpp.PLUGIN_LOAD, new Messages.Load(GENERATION,
        1, jar.toString(), sha256(jar), dataDir.toString(), s).write()), Duration.ofSeconds(30)));
    if (sandbox) {
      assertThat(loaded.sandbox()).isEqualTo("sandbox-exec");
    }
    return loaded;
  }

  /** The core's file rules for a host on macOS, with this test's home and data folder. */
  private String macProfile() throws IOException {
    String user = System.getProperty("user.home");
    StringBuilder b = new StringBuilder("(version 1)\n(allow default)\n(deny file-write* (subpath \"/\"))\n"
        + "(allow file-write* (subpath \"/dev\"))\n(deny file-read* file-write*\n");
    for (String denied : List.of(home.toString(), user + "/.ssh", user + "/.aws")) {
      b.append("  (subpath \"").append(denied).append("\")\n");
    }
    b.append(")\n(allow file-read* file-write* (subpath \"").append(dataDir.toRealPath()).append("\"))\n");
    b.append("(allow file-read-metadata (literal \"").append(home).append("\") (literal \"")
        .append(home.resolve("plugin-data")).append("\"))\n");
    b.append("(deny network-outbound (remote ip \"*:7465\") (remote ip \"*:7466\"))\n");
    return b.toString();
  }

  private JsonNode execute(ToolCall call) throws Exception {
    return execute(call, grant());
  }

  private JsonNode execute(ToolCall call, Messages.EgressGrant grant) throws Exception {
    Messages.Execute e = new Messages.Execute(GENERATION, "ct_" + System.nanoTime(), call, connection(), 10_000,
        false, null, null, null, DEV, null, null, grant);
    return await(peer.request(Gpp.CONNECTOR_EXECUTE, e.write()), Duration.ofSeconds(15));
  }

  private JsonNode await(JsonRpcPeer.Call<JsonNode> call, Duration timeout) throws Exception {
    try {
      return call.get(timeout);
    } catch (RpcException e) {
      throw new IllegalStateException(e.getMessage() + " (host: " + stderr + ")", e);
    }
  }

  private void pumpStderr() {
    try (InputStream err = process.getErrorStream();
        BufferedReader reader = new BufferedReader(new InputStreamReader(err, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        stderr.add(line);
      }
    } catch (IOException e) {
      // Ended.
    }
  }

  private static Map<String, String> hashes(List<ToolDefinition> tools) {
    Map<String, String> out = new LinkedHashMap<>();
    tools.forEach(t -> out.put(t.name(), WireCodec.definitionHash(t)));
    return out;
  }

  private static String sha256(Path file) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file)));
  }
}
