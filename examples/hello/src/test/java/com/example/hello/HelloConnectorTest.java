package com.example.hello;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ai.msrv.gaterook.connector.api.ActionPreview;
import ai.msrv.gaterook.connector.api.Classification;
import ai.msrv.gaterook.connector.api.ConnectionConfig;
import ai.msrv.gaterook.connector.api.Connector;
import ai.msrv.gaterook.connector.api.ConnectorException;
import ai.msrv.gaterook.connector.api.Env;
import ai.msrv.gaterook.connector.api.ExecContext;
import ai.msrv.gaterook.connector.api.Limits;
import ai.msrv.gaterook.connector.api.ModuleContext;
import ai.msrv.gaterook.connector.api.PolicyView;
import ai.msrv.gaterook.connector.api.ToolCall;
import ai.msrv.gaterook.connector.api.ToolDefinition;
import ai.msrv.gaterook.connector.api.ToolResult;
import ai.msrv.gaterook.plugin.protocol.ModuleManifests;
import ai.msrv.gaterook.plugin.protocol.PluginManifest;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * The connector in this JVM, without a module host: what it declares, how it judges and describes a call, and what
 * it runs. The module host and the core add everything around it (the sandbox, the policy, approvals, masking).
 */
class HelloConnectorTest {

  private static final JsonMapper JSON = JsonMapper.builder().build();
  private static final Limits LIMITS = new Limits(1000, 1000, 524_288, 1_048_576, 262_144, 65_536, 8192,
      Duration.ofSeconds(5), Duration.ofSeconds(30), Duration.ofSeconds(10), null);
  private static final PolicyView POLICY = new PolicyView(Env.DEV, "dev.hello", null, LIMITS);

  @TempDir
  Path data;

  private final HelloConnector connector = new HelloConnector("1.0.0");
  private final ConnectionConfig team = new ConnectionConfig("c_team", "team-hello", "hello", Env.DEV, 1,
      JSON.createObjectNode().put("greeting", "Good morning"), Set.of(), null);

  @Test
  void theBuildWritesAManifestGateRookAccepts() throws Exception {
    // What the build does (pom.xml): module.json and the module's own connectors make the package's manifest.
    JsonNode descriptor = JSON.readTree(Path.of("module.json").toFile());
    List<Connector> connectors = new HelloModule().connectors(context(descriptor));
    PluginManifest manifest = PluginManifest.parse(ModuleManifests.write(descriptor, connectors));

    assertThat(manifest.module()).isTrue();
    assertThat(manifest.id()).isEqualTo("hello");
    assertThat(manifest.moduleClass()).isEqualTo(HelloModule.class.getName());
    assertThat(manifest.types()).extracting(PluginManifest.Type::id).containsExactly("hello");
    assertThat(manifest.tools()).extracting(ToolDefinition::name).containsExactly("hello_greet", "hello_note");
    // The package's file name carries the version of module.json: the pom's version must be the same.
    assertThat(manifest.version()).isEqualTo(System.getProperty("module.build.version", manifest.version()));
  }

  @Test
  void aGreetingIsAReadThatUsesTheConnectionsGreeting() throws Exception {
    ToolCall call = call("hello_greet", "{\"name\":\"Ada\"}");
    assertThat(connector.classify(call, team, POLICY).kind()).isEqualTo(Classification.Kind.READ);

    ToolResult result = connector.execute(call, team, null, context(false, null));
    assertThat(result.isError()).isFalse();
    assertThat(result.structuredContent().path("greeting").asString()).isEqualTo("Good morning, Ada!");
  }

  @Test
  void aNoteIsAChangeThatRunsOnlyWhenApprovedAndWritesWhatWasApproved() throws Exception {
    ToolCall call = call("hello_note", "{\"text\":\"Rotate the staging key on Friday\"}");
    assertThat(connector.classify(call, team, POLICY).kind()).isEqualTo(Classification.Kind.MUTATION);

    ActionPreview shown = connector.describeAction(call, team);
    assertThat(shown.text()).as("exactly what will be written").isEqualTo("Rotate the staging key on Friday");
    assertThat(shown.target()).isEqualTo("team-hello · notes");

    assertThatThrownBy(() -> connector.execute(call, team, null, context(false, null)))
        .isInstanceOf(ConnectorException.class).hasMessageStartingWith("Not approved");
    assertThat(HelloConnector.notes(team, context(false, null))).doesNotExist();

    connector.execute(call, team, null, context(true, shown.payload()));
    assertThat(Files.readString(HelloConnector.notes(team, context(false, null))))
        .isEqualTo("Rotate the staging key on Friday\n");
  }

  @Test
  void aNoteOfSeveralLinesIsDeniedBeforeAnyoneIsAsked() {
    Classification denied = connector.classify(call("hello_note", "{\"text\":\"one\\ntwo\"}"), team, POLICY);
    assertThat(denied.kind()).isEqualTo(Classification.Kind.DENY);
    assertThat(denied.ruleId()).isEqualTo("dev.hello.one-line");
  }

  @Test
  void testConnectionSaysWhatTheConnectionMayDo() {
    var tested = connector.test(team, null, context(false, null));
    assertThat(tested.ok()).isTrue();
    assertThat(tested.serverVersion()).isEqualTo("Hello 1.0.0");
  }

  private static ToolCall call(String tool, String arguments) {
    return new ToolCall("tc_test", tool, "team-hello", (ObjectNode) JSON.readTree(arguments), null);
  }

  private static ModuleContext context(JsonNode descriptor) {
    return new ModuleContext() {
      @Override
      public String moduleId() {
        return descriptor.path("id").asString();
      }

      @Override
      public String moduleVersion() {
        return descriptor.path("version").asString();
      }
    };
  }

  /** What a call gets from the host, as far as this connector uses it: the data folder and whether it is approved. */
  private ExecContext context(boolean approved, JsonNode approvedPayload) {
    return new ExecContext() {
      @Override
      public String callId() {
        return "tc_test";
      }

      @Override
      public String traceId() {
        return "trace";
      }

      @Override
      public String traceparent() {
        return null;
      }

      @Override
      public Env env() {
        return Env.DEV;
      }

      @Override
      public Limits limits() {
        return LIMITS;
      }

      @Override
      public Duration timeout() {
        return Duration.ofSeconds(10);
      }

      @Override
      public Instant deadline() {
        return Instant.now().plusSeconds(10);
      }

      @Override
      public boolean cancelled() {
        return false;
      }

      @Override
      public void onCancel(Runnable action) {}

      @Override
      public boolean approved() {
        return approved;
      }

      @Override
      public Optional<String> approvalId() {
        return approved ? Optional.of("ap_test") : Optional.empty();
      }

      @Override
      public Optional<JsonNode> preparedState() {
        return Optional.empty();
      }

      @Override
      public Optional<JsonNode> approvedPayload() {
        return Optional.ofNullable(approvedPayload);
      }

      @Override
      public System.Logger log() {
        return System.getLogger("hello");
      }

      @Override
      public Clock clock() {
        return Clock.systemUTC();
      }

      @Override
      public HandleCodec handles() {
        throw new UnsupportedOperationException("This connector seals no handles");
      }

      @Override
      public boolean acquire(String remoteQuotaKey, int permitsPerMinute) {
        return true;
      }

      @Override
      public Path workDir() {
        return data;
      }

      @Override
      public Egress egress() {
        throw new UnsupportedOperationException("This connector reaches no host");
      }

      @Override
      public void taint(CharSequence value) {}
    };
  }
}
