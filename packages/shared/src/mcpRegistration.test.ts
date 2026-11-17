import { describe, expect, it } from "vite-plus/test";

import {
  isValidMcpToolName,
  mcpServerIdFromName,
  parseMcpRegistration,
  resolveMcpLaunch,
} from "./mcpRegistration.ts";

const serverJson = (packages: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  schemaVersion: "2025-09-29",
  name: "io.acme/team-notes",
  description: "Search the team's notes.",
  ...extra,
  packages,
});

const npmPackage = {
  registryType: "npm",
  identifier: "@acme/team-notes-mcp",
  version: "1.4.2",
  transport: { type: "stdio" },
  environmentVariables: [
    {
      name: "TEAM_NOTES_TOKEN",
      description: "Workspace API token.",
      isRequired: true,
      isSecret: true,
    },
    { name: "TEAM_NOTES_REGION", default: "us", choices: ["us", "eu"] },
    { name: "TEAM_NOTES_HOME", format: "filepath", isRequired: false },
  ],
  packageArguments: [{ type: "named", name: "--cache", value: "{TEAM_NOTES_HOME}" }],
};

const mcpbManifest = {
  manifest_version: "0.2",
  name: "acme-notes",
  display_name: "Acme Notes",
  description: "Notes as MCP.",
  server: {
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js", "--data", "${user_config.data_dir}"],
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
  },
};

describe("parseMcpRegistration", () => {
  it.each([
    {
      label: "server.json with an npm package",
      source: serverJson([npmPackage]),
      expectedKind: "server.json",
      expectedName: "io.acme/team-notes",
      expectedFields: [
        {
          key: "TEAM_NOTES_TOKEN",
          label: "TEAM_NOTES_TOKEN",
          type: "string",
          required: true,
          secret: true,
          description: "Workspace API token.",
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
      label: "an MCPB manifest",
      source: mcpbManifest,
      expectedKind: "mcpb",
      expectedName: "Acme Notes",
      expectedFields: [
        {
          key: "data_dir",
          label: "Data folder",
          type: "path",
          required: true,
          secret: false,
          description: "Where notes live.",
        },
        {
          key: "token",
          label: "API token",
          type: "string",
          required: true,
          secret: true,
        },
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
      ],
    },
  ])("reads $label", ({ source, expectedKind, expectedName, expectedFields }) => {
    const parsed = parseMcpRegistration(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.registration.sourceKind).toBe(expectedKind);
    expect(parsed.registration.name).toBe(expectedName);
    expect(parsed.registration.fields).toEqual(expectedFields);
  });

  it.each([
    {
      label: "a remote-only server",
      source: serverJson([], {
        remotes: [{ type: "streamable-http", url: "https://notes.acme.test/mcp" }],
      }),
      message: "remote servers are not supported",
    },
    {
      label: "a non-stdio package",
      source: serverJson([{ ...npmPackage, transport: { type: "sse" } }]),
      message: "only a stdio package is supported",
    },
    {
      label: "an unsupported registry",
      source: serverJson([{ ...npmPackage, registryType: "nuget" }]),
      message: "Unsupported package registryType nuget",
    },
    {
      label: "a document that names nothing",
      source: { hello: "world" },
      message: "server.json has no name",
    },
    {
      label: "a value that is not an object",
      source: ["not", "a", "manifest"],
      message: "Paste a server.json document",
    },
  ])("rejects $label", ({ source, message }) => {
    const parsed = parseMcpRegistration(source);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain(message);
  });
});

describe("resolveMcpLaunch", () => {
  it("launches an npm package with placeholders and named arguments filled in", () => {
    const resolved = resolveMcpLaunch({
      source: { kind: "server.json", document: serverJson([npmPackage]) },
      config: {
        TEAM_NOTES_TOKEN: "s3cret",
        TEAM_NOTES_REGION: "eu",
        TEAM_NOTES_HOME: "/home/user/notes",
      },
    });
    expect(resolved).toEqual({
      ok: true,
      launch: {
        command: "npx",
        args: ["-y", "@acme/team-notes-mcp@1.4.2", "--cache", "/home/user/notes"],
        env: {
          TEAM_NOTES_TOKEN: "s3cret",
          TEAM_NOTES_REGION: "eu",
          TEAM_NOTES_HOME: "/home/user/notes",
        },
      },
    });
  });

  it("launches pypi and oci packages with their own runners", () => {
    const pypi = resolveMcpLaunch({
      source: {
        kind: "server.json",
        document: serverJson([
          { ...npmPackage, registryType: "pypi", identifier: "acme-notes", version: "2.0.0" },
        ]),
      },
      config: { TEAM_NOTES_TOKEN: "s3cret" },
    });
    expect(pypi.ok && pypi.launch.args.slice(0, 1)).toEqual(["acme-notes==2.0.0"]);

    const oci = resolveMcpLaunch({
      source: {
        kind: "server.json",
        document: serverJson([
          {
            registryType: "oci",
            identifier: "ghcr.io/acme/notes:1",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "TEAM_NOTES_TOKEN", isRequired: true, isSecret: true }],
          },
        ]),
      },
      config: { TEAM_NOTES_TOKEN: "s3cret" },
    });
    expect(oci.ok && oci.launch).toMatchObject({
      command: "docker",
      args: ["run", "-i", "--rm", "ghcr.io/acme/notes:1"],
    });
  });

  it("launches an MCPB manifest from its bundle directory", () => {
    const resolved = resolveMcpLaunch(
      {
        source: { kind: "mcpb", manifest: mcpbManifest, bundleDir: "/opt/acme-notes" },
        config: { data_dir: "/home/user/acme", token: "t0ken" },
      },
      { home: "/home/user" },
    );
    expect(resolved).toEqual({
      ok: true,
      launch: {
        command: "node",
        args: ["/opt/acme-notes/dist/index.js", "--data", "/home/user/acme"],
        env: { ACME_TOKEN: "t0ken", ACME_HOME: "/home/user" },
      },
    });
  });

  it("refuses to launch without a required value", () => {
    const resolved = resolveMcpLaunch({
      source: { kind: "server.json", document: serverJson([npmPackage]) },
      config: { TEAM_NOTES_HOME: "/home/user/notes" },
    });
    expect(resolved).toEqual({
      ok: false,
      message: "Set TEAM_NOTES_TOKEN before this MCP server can start.",
    });
  });
});

describe("mcpServerIdFromName", () => {
  it("slugs a name into a stable id", () => {
    expect(mcpServerIdFromName("Acme Notes!")).toBe("acme-notes");
    expect(mcpServerIdFromName("io.acme/team-notes")).toBe("io-acme-team-notes");
    expect(mcpServerIdFromName("   ")).toBe("mcp-server");
  });
});

describe("isValidMcpToolName", () => {
  it("accepts lowercase prefixes and rejects the rest", () => {
    expect(isValidMcpToolName("acme_notes")).toBe(true);
    expect(isValidMcpToolName("Acme")).toBe(false);
    expect(isValidMcpToolName("1acme")).toBe(false);
    expect(isValidMcpToolName("acme notes")).toBe(false);
  });
});
