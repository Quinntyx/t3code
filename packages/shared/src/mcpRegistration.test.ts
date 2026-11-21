import { describe, expect, it } from "vite-plus/test";

import {
  isValidMcpToolName,
  parseMcpRegistration,
  resolveMcpLaunch,
  type McpConfigValue,
} from "./mcpRegistration.ts";

const serverJson = (packages: ReadonlyArray<unknown>) => ({
  schemaVersion: "2025-09-29",
  name: "io.acme/team-notes",
  description: "Search the team's notes.",
  packages,
});

const stdioPackage = (overrides: Record<string, unknown> = {}) => ({
  registryType: "npm",
  identifier: "@acme/notes-mcp",
  version: "1.4.2",
  transport: { type: "stdio" },
  ...overrides,
});

const npmPackage = stdioPackage({
  identifier: "@acme/team-notes-mcp",
  environmentVariables: [
    {
      name: "TEAM_NOTES_TOKEN",
      description: "Workspace API token.",
      isRequired: true,
      isSecret: true,
    },
    { name: "TEAM_NOTES_REGION", default: "us", choices: ["us", "eu"] },
    { name: "TEAM_NOTES_HOME", format: "filepath" },
  ],
  packageArguments: [{ type: "named", name: "--cache", value: "{TEAM_NOTES_HOME}" }],
});

const argumentsPackage = stdioPackage({
  packageArguments: [
    { type: "positional", valueHint: "workspace", isRequired: true },
    { type: "named", name: "--port", valueHint: "port", format: "number", default: "8080" },
    { type: "named", name: "--stdio" },
    {
      type: "named",
      name: "--auth",
      value: "Bearer {api_key}",
      variables: { api_key: { isSecret: true, description: "API key." } },
    },
    { type: "named", name: "--debug", valueHint: "debug", format: "boolean", default: "true" },
  ],
});

const mcpbManifest = {
  manifest_version: "0.2",
  name: "acme-notes",
  display_name: "Acme Notes",
  description: "Notes as MCP.",
  server: {
    mcp_config: {
      command: "node",
      args: [
        "${__dirname}/dist/index.js",
        "--data",
        "${user_config.data_dir}",
        "${user_config.dirs}",
      ],
      env: { ACME_TOKEN: "${user_config.token}", ACME_HOME: "${HOME}" },
    },
  },
  user_config: {
    data_dir: {
      type: "directory",
      title: "Data folder",
      description: "Where notes live.",
      required: true,
    },
    token: { type: "string", title: "API token", sensitive: true, required: true },
    retries: { type: "number", title: "Retries", default: 3, min: 0, max: 10 },
    verbose: { type: "boolean", title: "Verbose logging" },
    dirs: { type: "directory", title: "Allowed", multiple: true, default: ["${HOME}/Desktop"] },
  },
};

const fieldsOf = (document: unknown) => {
  const result = parseMcpRegistration(document);
  if (!result.ok) throw new Error(result.message);
  return result.registration.fields;
};

describe("parseMcpRegistration", () => {
  it.each([
    {
      label: "server.json environment variables and a template argument",
      document: serverJson([npmPackage]),
      fields: [
        {
          key: "TEAM_NOTES_TOKEN",
          label: "TEAM_NOTES_TOKEN",
          description: "Workspace API token.",
          type: "string",
          required: true,
          secret: true,
        },
        {
          key: "TEAM_NOTES_REGION",
          label: "TEAM_NOTES_REGION",
          type: "choice",
          required: false,
          secret: false,
          default: "us",
          choices: ["us", "eu"],
        },
        // The template names the same variable, which the environment variable already declared.
        {
          key: "TEAM_NOTES_HOME",
          label: "TEAM_NOTES_HOME",
          type: "path",
          required: false,
          secret: false,
        },
      ],
    },
    {
      label: "server.json arguments, with typed defaults and no field for a bare flag",
      document: serverJson([argumentsPackage]),
      fields: [
        { key: "workspace", label: "Workspace", type: "string", required: true, secret: false },
        {
          key: "port",
          label: "Port",
          type: "number",
          required: false,
          secret: false,
          default: 8080,
        },
        {
          key: "api_key",
          label: "Api Key",
          description: "API key.",
          type: "string",
          required: false,
          secret: true,
        },
        {
          key: "debug",
          label: "Debug",
          type: "boolean",
          required: false,
          secret: false,
          default: true,
        },
      ],
    },
    {
      label: "MCPB user_config",
      document: mcpbManifest,
      fields: [
        {
          key: "data_dir",
          label: "Data folder",
          description: "Where notes live.",
          type: "path",
          required: true,
          secret: false,
        },
        { key: "token", label: "API token", type: "string", required: true, secret: true },
        {
          key: "retries",
          label: "Retries",
          type: "number",
          required: false,
          secret: false,
          default: 3,
          min: 0,
          max: 10,
        },
        {
          key: "verbose",
          label: "Verbose logging",
          type: "boolean",
          required: false,
          secret: false,
        },
        {
          key: "dirs",
          label: "Allowed",
          type: "path",
          required: false,
          secret: false,
          default: ["${HOME}/Desktop"],
          multiple: true,
        },
      ],
    },
  ])("reads the fields from $label", ({ document, fields }) => {
    expect(fieldsOf(document)).toEqual(fields);
  });

  it("names the server from its document", () => {
    expect(parseMcpRegistration(serverJson([npmPackage]))).toMatchObject({
      ok: true,
      registration: { name: "io.acme/team-notes", sourceKind: "server.json" },
    });
    expect(parseMcpRegistration(mcpbManifest)).toMatchObject({
      ok: true,
      registration: { name: "Acme Notes", description: "Notes as MCP.", sourceKind: "mcpb" },
    });
  });

  it.each([
    { label: "a non-object", document: [], message: "Paste a server.json" },
    {
      label: "a nameless server.json",
      document: { packages: [stdioPackage()] },
      message: "no name",
    },
    {
      label: "a remote-only server.json",
      document: { name: "acme/remote", remotes: [{ type: "streamable-http", url: "https://x" }] },
      message: "remote servers are not supported",
    },
    {
      label: "a non-stdio package",
      document: serverJson([stdioPackage({ transport: { type: "streamable-http" } })]),
      message: "only a stdio package",
    },
    {
      label: "an unknown registry",
      document: serverJson([stdioPackage({ registryType: "nuget" })]),
      message: "Unsupported package registryType nuget",
    },
    {
      label: "a package without an identifier",
      document: serverJson([stdioPackage({ identifier: " " })]),
      message: "no identifier",
    },
    {
      label: "an MCPB manifest without a command",
      document: { ...mcpbManifest, server: { mcp_config: { command: " " } } },
      message: "no server.mcp_config command",
    },
  ])("refuses $label", ({ document, message }) => {
    const result = parseMcpRegistration(document);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain(message);
  });
});

describe("resolveMcpLaunch", () => {
  const launch = (document: unknown, config: Record<string, McpConfigValue> = {}) =>
    resolveMcpLaunch({ source: { kind: "server.json", document }, config }, { home: "/home/me" });

  it.each([
    {
      label: "an npm package, dropping the flag of an unset optional template",
      document: serverJson([npmPackage]),
      config: { TEAM_NOTES_TOKEN: "s3cret" },
      expected: {
        command: "npx",
        args: ["-y", "@acme/team-notes-mcp@1.4.2"],
        env: { TEAM_NOTES_TOKEN: "s3cret", TEAM_NOTES_REGION: "us" },
      },
    },
    {
      label: "an npm package with its template filled",
      document: serverJson([npmPackage]),
      config: { TEAM_NOTES_TOKEN: "s3cret", TEAM_NOTES_HOME: "/notes" },
      expected: {
        command: "npx",
        args: ["-y", "@acme/team-notes-mcp@1.4.2", "--cache", "/notes"],
        env: { TEAM_NOTES_TOKEN: "s3cret", TEAM_NOTES_REGION: "us", TEAM_NOTES_HOME: "/notes" },
      },
    },
    {
      label: "positional, named, bare and template arguments",
      document: serverJson([argumentsPackage]),
      config: { workspace: "team", api_key: "k" },
      expected: {
        command: "npx",
        args: [
          "-y",
          "@acme/notes-mcp@1.4.2",
          "team",
          "--port",
          "8080",
          "--stdio",
          "--auth",
          "Bearer k",
          "--debug",
          "true",
        ],
        env: {},
      },
    },
    {
      label: "the first runnable package, on its own runner",
      document: serverJson([
        stdioPackage({ transport: { type: "sse" } }),
        stdioPackage({ registryType: "pypi", identifier: "acme-notes", version: "2.0" }),
      ]),
      config: {},
      expected: { command: "uvx", args: ["acme-notes==2.0"], env: {} },
    },
    {
      label: "an oci image, passing env by name and runtime arguments before the image",
      document: serverJson([
        stdioPackage({
          registryType: "oci",
          identifier: "ghcr.io/acme/notes:1",
          environmentVariables: [{ name: "NOTES_TOKEN", isSecret: true }],
          runtimeArguments: [{ type: "named", name: "--network", value: "host" }],
        }),
      ]),
      config: { NOTES_TOKEN: "t" },
      expected: {
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "-e",
          "NOTES_TOKEN",
          "--network",
          "host",
          "ghcr.io/acme/notes:1",
        ],
        env: { NOTES_TOKEN: "t" },
      },
    },
    {
      label: "a runtime hint in place of the default runner",
      document: serverJson([stdioPackage({ runtimeHint: "bunx" })]),
      config: {},
      expected: { command: "bunx", args: ["@acme/notes-mcp@1.4.2"], env: {} },
    },
  ])("launches $label", ({ document, config, expected }) => {
    expect(launch(document, config)).toEqual({ ok: true, launch: expected });
  });

  it("launches an MCPB manifest from its bundle directory", () => {
    expect(
      resolveMcpLaunch(
        {
          source: { kind: "mcpb", manifest: mcpbManifest, bundleDir: "/bundles/notes" },
          // A secret is passed exactly as typed, even when it looks like a substitution.
          config: { data_dir: "${HOME}/notes", token: "${HOME}-token" },
        },
        { home: "/home/me" },
      ),
    ).toEqual({
      ok: true,
      launch: {
        command: "node",
        // The list default expands to one argument per item, with `${HOME}` resolved.
        args: ["/bundles/notes/dist/index.js", "--data", "/home/me/notes", "/home/me/Desktop"],
        env: { ACME_TOKEN: "${HOME}-token", ACME_HOME: "/home/me" },
      },
    });
  });

  it("refuses to launch without a required value", () => {
    expect(launch(serverJson([npmPackage]))).toEqual({
      ok: false,
      message: "Set TEAM_NOTES_TOKEN before this MCP server can start.",
    });
  });
});

describe("isValidMcpToolName", () => {
  it.each([
    { name: "notes", valid: true },
    { name: "team_notes-2", valid: true },
    { name: "Notes", valid: false },
    { name: "2notes", valid: false },
    { name: "notes.v2", valid: false },
    { name: "n".repeat(41), valid: false },
  ])("$name is valid: $valid", ({ name, valid }) => {
    expect(isValidMcpToolName(name)).toBe(valid);
  });
});
