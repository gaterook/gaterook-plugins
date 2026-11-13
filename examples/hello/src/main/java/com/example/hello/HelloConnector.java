package com.example.hello;

import ai.msrv.gaterook.connector.api.ActionPreview;
import ai.msrv.gaterook.connector.api.Classification;
import ai.msrv.gaterook.connector.api.ConnectionConfig;
import ai.msrv.gaterook.connector.api.Connector;
import ai.msrv.gaterook.connector.api.ConnectorException;
import ai.msrv.gaterook.connector.api.ConnectorManifest;
import ai.msrv.gaterook.connector.api.ExecContext;
import ai.msrv.gaterook.connector.api.PolicyView;
import ai.msrv.gaterook.connector.api.SecretResolver;
import ai.msrv.gaterook.connector.api.TestResult;
import ai.msrv.gaterook.connector.api.ToolCall;
import ai.msrv.gaterook.connector.api.ToolDefinition;
import ai.msrv.gaterook.connector.api.ToolResult;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * One connector type, {@code hello}, with a read and a change. A connection holds a greeting; {@code hello_greet}
 * answers with it, and {@code hello_note} adds one line to a notes file in the module's own data folder after a
 * person approved exactly that line.
 *
 * <p>The connector says what its type is (the card, the connection form, the tools) and judges, describes and runs
 * calls. It knows nothing of endpoints, agents, tokens or people: the core decides who may call what.
 */
public final class HelloConnector implements Connector {

  static final String GREET = "hello_greet";
  static final String NOTE = "hello_note";

  private static final JsonMapper JSON = JsonMapper.builder().build();

  /** The connection form: JSON Schema 2020-12. A secret would be a property with {@code "writeOnly": true}. */
  private static final String CONFIG_SCHEMA = """
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["greeting"],
        "properties": {
          "greeting": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40,
            "default": "Hello",
            "title": "Greeting",
            "description": "The word every greeting of this connection starts with."
          }
        }
      }
      """;

  /** Every tool takes {@code connection} first: the core resolves it and hands the call the connection it names. */
  private static final String GREET_INPUT = """
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["connection", "name"],
        "properties": {
          "connection": {"type": "string"},
          "name": {"type": "string", "minLength": 1, "maxLength": 80, "description": "Whom to greet."}
        }
      }
      """;

  private static final String NOTE_INPUT = """
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["connection", "text"],
        "properties": {
          "connection": {"type": "string"},
          "text": {"type": "string", "minLength": 1, "maxLength": 200, "description": "The note, one line."}
        }
      }
      """;

  private final ConnectorManifest manifest;

  public HelloConnector(String version) {
    ToolDefinition greet = ToolDefinition.builder(GREET)
        .title("Greet")
        .description("Greets someone by name with the connection's greeting.")
        .inputSchema(json(GREET_INPUT))
        .annotations(ToolDefinition.Annotations.read())
        .nature(ToolDefinition.Nature.READ)
        // A read runs at once, on every environment.
        .defaultMode(ToolDefinition.Mode.READ_ONLY, ToolDefinition.Mode.READ_ONLY)
        .resultShape(ToolDefinition.ResultShape.JSON)
        .build();
    ToolDefinition note = ToolDefinition.builder(NOTE)
        .title("Add a note")
        .description("Adds one line to the connection's notes. A person approves the line first.")
        .inputSchema(json(NOTE_INPUT))
        .annotations(ToolDefinition.Annotations.write(false))
        .nature(ToolDefinition.Nature.MUTATION)
        // A change waits for a person; a mutating tool can't default to Read only.
        .defaultMode(ToolDefinition.Mode.APPROVAL, ToolDefinition.Mode.APPROVAL)
        .resultShape(ToolDefinition.ResultShape.TEXT)
        .build();
    // A module's connector types are BUILT_IN types: plain tool names and their own default modes.
    this.manifest = ConnectorManifest.builder("hello", version, ConnectorManifest.Kind.BUILT_IN)
        .name("Hello")
        .description("Greets by name and keeps one-line notes. An example of a connector module.")
        .configSchema(json(CONFIG_SCHEMA))
        .tools(List.of(greet, note))
        .build();
  }

  @Override
  public ConnectorManifest manifest() {
    return manifest;
  }

  /** No I/O and no secrets here: it runs before the policy, on every call, and a failure denies the call. */
  @Override
  public Classification classify(ToolCall call, ConnectionConfig cfg, PolicyView policy) {
    return switch (call.tool()) {
      case GREET -> Classification.read();
      case NOTE -> {
        String text = call.string("text");
        yield text == null || text.isBlank() || text.contains("\n") || text.contains("\r")
            ? Classification.deny(policy.rule("one-line"), "A note is one line of text.", "Send one line in text.")
            : Classification.mutation("Adds a note to " + cfg.name() + ".");
      }
      default -> Classification.deny(policy.rule("unknown-tool"), call.tool() + " isn't a tool of Hello.", null);
    };
  }

  /** What a person approves: the text is exactly what will be written, never a paraphrase. No I/O. */
  @Override
  public ActionPreview describeAction(ToolCall call, ConnectionConfig cfg) {
    if (NOTE.equals(call.tool())) {
      String text = call.string("text");
      return ActionPreview.of(ActionPreview.Kind.TEXT, "text", text == null ? "" : text, cfg.name() + " · notes",
          "Add a note to " + cfg.name()).withPayload(call.arguments());
    }
    return ActionPreview.of(ActionPreview.Kind.TEXT, "text", call.tool() + " " + call.arguments(), cfg.name(),
        "Greet " + call.string("name"));
  }

  /** Test connection: saves nothing. Here it checks that the notes folder can be written. */
  @Override
  public TestResult test(ConnectionConfig cfg, SecretResolver secrets, ExecContext ctx) {
    long started = System.nanoTime();
    try {
      Files.createDirectories(ctx.workDir());
      if (!Files.isWritable(ctx.workDir())) {
        return TestResult.failure("notes.read-only", "The notes folder can't be written.", ctx.workDir().toString());
      }
    } catch (IOException e) {
      return TestResult.failure("notes.unavailable", "The notes folder can't be used: " + e.getMessage(), null);
    }
    long ms = (System.nanoTime() - started) / 1_000_000;
    return TestResult.success(ms, "Hello " + manifest.version(), null, new TestResult.Permissions(
        TestResult.Level.WRITE, "Greets", "Adds notes to its own folder", List.of(), null));
  }

  @Override
  public ToolResult execute(ToolCall call, ConnectionConfig cfg, SecretResolver secrets, ExecContext ctx)
      throws ConnectorException {
    switch (call.tool()) {
      case GREET -> {
        String greeting = cfg.string("/greeting");
        String text = (greeting == null || greeting.isBlank() ? "Hello" : greeting) + ", " + call.string("name") + "!";
        return ToolResult.json(JSON.createObjectNode().put("greeting", text), text);
      }
      case NOTE -> {
        if (!ctx.approved()) {
          // Defence in depth: the core sends a change only after a person approved it, or the tool is in Bypass.
          throw ConnectorException.denied("Not approved: hello_note changes the notes, so a person approves it "
              + "first.");
        }
        // What was approved is what runs: the approved payload when the core passes it on, else the call's own text.
        String text = ctx.approvedPayload().filter(p -> p.path("text").isString())
            .map(p -> p.get("text").asString()).orElse(call.string("text"));
        Path notes = notes(cfg, ctx);
        try {
          Files.createDirectories(notes.getParent());
          Files.writeString(notes, text + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE,
              StandardOpenOption.APPEND);
        } catch (IOException e) {
          throw ConnectorException.resourceError("The note couldn't be written: " + e.getMessage(), e);
        }
        return ToolResult.text("Noted for " + cfg.name() + ".");
      }
      default -> throw ConnectorException.badInput(call.tool() + " isn't a tool of Hello.");
    }
  }

  /** One file per connection, in the module's data folder: the only place a module writes. */
  static Path notes(ConnectionConfig cfg, ExecContext ctx) {
    return ctx.workDir().resolve("notes-" + cfg.id().replaceAll("[^A-Za-z0-9_-]", "_") + ".txt");
  }

  private static JsonNode json(String text) {
    return JSON.readTree(text);
  }
}
