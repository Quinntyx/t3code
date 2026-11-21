import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A config value a registered MCP server accepts from the user. */
export const RegisteredMcpServerConfigValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type RegisteredMcpServerConfigValue = typeof RegisteredMcpServerConfigValue.Type;

/** The pasted document verbatim, so the launch command can be re-derived without the registry. */
export const RegisteredMcpServerSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("server.json"), document: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("mcpb"),
    manifest: Schema.Unknown,
    bundleDir: Schema.String,
  }),
]);
export type RegisteredMcpServerSource = typeof RegisteredMcpServerSource.Type;

/**
 * One locally launched MCP server the user registered. A secret config value is kept in the
 * settings secret store, so `config` holds only the redaction marker for a saved one.
 */
export const RegisteredMcpServerEntry = Schema.Struct({
  /** Stable id, also the settings page path. */
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Prefix for the server's tools as T3 exposes them. */
  toolName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  source: RegisteredMcpServerSource,
  config: Schema.Record(Schema.String, RegisteredMcpServerConfigValue),
});
export type RegisteredMcpServerEntry = typeof RegisteredMcpServerEntry.Type;

export const RegisteredMcpServerStatus = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "failed",
]);
export type RegisteredMcpServerStatus = typeof RegisteredMcpServerStatus.Type;

export const RegisteredMcpServerState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  toolName: Schema.String,
  enabled: Schema.Boolean,
  status: RegisteredMcpServerStatus,
  /** The end of the child's stderr when it failed to start or crashed. */
  stderrTail: Schema.optionalKey(Schema.String),
  /** The server's own tool names, in its order. */
  tools: Schema.Array(Schema.String),
  /** Tools T3 could not expose because another tool already answers to their name. */
  skippedTools: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type RegisteredMcpServerState = typeof RegisteredMcpServerState.Type;

export const RegisteredMcpServersState = Schema.Struct({
  servers: Schema.Array(RegisteredMcpServerState),
});
export type RegisteredMcpServersState = typeof RegisteredMcpServersState.Type;

export const maxMcpToolPrefixLength = 40;

/** `name` as a stable settings id: lowercase letters, digits and single dashes. */
export function mcpServerIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug === "" ? "mcp-server" : slug;
}

export const registeredMcpServersDefault = Schema.Array(RegisteredMcpServerEntry).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);
