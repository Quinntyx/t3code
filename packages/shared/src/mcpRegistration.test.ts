import { describe, expect, it } from "vite-plus/test";

import { isValidMcpToolName, parseMcpRegistration, resolveMcpLaunch } from "./mcpRegistration.ts";

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
      args: [
        "${__dirname}/dist/index.js",
        "--data",
        "${user_config.data_dir}",
        "${user_config.labels}",
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
    labels: { type: "string", title: "Labels", multiple: true },
    quota: { type: "number", title: "Quota", sensitive: true },
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
        {
          key: "labels",
          label: "Labels",
          type: "string",
          required: false,
          secret: false,
          multiple: true,
        },
        // A sensitive number is stored as a secret string, since only strings become secrets.
        {
          key: "quota",
          label: "Quota",
          type: "string",
          required: false,
          secret: true,
        },
      ],
    },
    {
      label: "a server.json environment variable with a value or a value template",
      source: serverJson([
        {
          ...npmPackage,
          packageArguments: [],
          environmentVariables: [
            // A fixed value needs nothing from the user, so it declares no field here.
            { name: "TEAM_NOTES_REGION", value: "eu" },
            {
              name: "TEAM_NOTES_HOME",
              value: "{NOTES_DIR}",
              variables: { NOTES_DIR: { description: "Where notes live.", format: "filepath" } },
            },
          ],
        },
      ]),
      expectedKind: "server.json",
      expectedName: "io.acme/team-notes",
      expectedFields: [
        {
          key: "NOTES_DIR",
          label: "NOTES DIR",
          type: "path",
          required: false,
          secret: false,
          description: "Where notes live.",
        },
      ],
    },
    {
      label: "a server.json argument with no value",
      source: serverJson([
        {
          ...npmPackage,
          packageArguments: [
            // A valueless named argument is a bare flag, not a setting.
            { type: "named", name: "--stdio" },
            // One that declares a value asks for it, and is emitted from what the user sets.
            {
              type: "named",
              name: "--token",
              valueHint: "token",
              isRequired: true,
              isSecret: true,
            },
            { type: "positional", valueHint: "workspace", description: "Workspace slug." },
          ],
        },
      ]),
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
        {
          key: "token",
          label: "Token",
          type: "string",
          required: true,
          secret: true,
          description: "Value for --token (package argument 2).",
        },
        {
          key: "argument_3",
          label: "Workspace",
          type: "string",
          required: false,
          secret: false,
          description: "Workspace slug.",
        },
      ],
    },
    {
      label: "a server.json argument with declared variables",
      source: serverJson([
        {
          ...npmPackage,
          packageArguments: [
            {
              type: "positional",
              value: "{NOTES_TOKEN}",
              variables: {
                NOTES_TOKEN: {
                  description: "Argument token.",
                  isRequired: true,
                  isSecret: true,
                  format: "filepath",
                  default: "~/.notes-token",
                },
              },
            },
            {
              type: "named",
              name: "--region",
              value: "{NOTES_REGION}",
              variables: {
                NOTES_REGION: { choices: ["us", "eu"], default: "us" },
              },
            },
          ],
        },
      ]),
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
        {
          key: "NOTES_TOKEN",
          label: "NOTES TOKEN",
          type: "path",
          required: true,
          secret: true,
          description: "Argument token.",
          default: "~/.notes-token",
        },
        {
          key: "NOTES_REGION",
          label: "NOTES REGION",
          type: "choice",
          required: false,
          secret: false,
          description: "Value for --region (package argument 2).",
          default: "us",
          choices: ["us", "eu"],
        },
      ],
    },
    {
      label: "a server.json variable declared secret by only one of its inputs",
      source: serverJson([
        {
          ...npmPackage,
          environmentVariables: [{ name: "SHARED_TOKEN" }],
          packageArguments: [
            {
              type: "positional",
              value: "{SHARED_TOKEN}",
              variables: { SHARED_TOKEN: { isRequired: true, isSecret: true } },
            },
          ],
        },
      ]),
      expectedKind: "server.json",
      expectedName: "io.acme/team-notes",
      expectedFields: [
        {
          key: "SHARED_TOKEN",
          label: "SHARED_TOKEN",
          type: "string",
          required: true,
          secret: true,
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

    // An unset optional value leaves no flag behind: the whole named argument goes.
    const unset = resolveMcpLaunch({
      source: { kind: "server.json", document: serverJson([npmPackage]) },
      config: { TEAM_NOTES_TOKEN: "s3cret" },
    });
    expect(unset.ok && unset.launch.args).toEqual(["-y", "@acme/team-notes-mcp@1.4.2"]);
  });

  it("launches a variable's literal value and a supplied argument", () => {
    const document = serverJson([
      {
        ...npmPackage,
        environmentVariables: [
          { name: "TEAM_NOTES_REGION", value: "eu" },
          {
            name: "TEAM_NOTES_HOME",
            value: "{NOTES_DIR}",
            variables: { NOTES_DIR: { format: "filepath" } },
          },
          { name: "TEAM_NOTES_TOKEN", isRequired: true, isSecret: true },
        ],
        packageArguments: [
          { type: "named", name: "--stdio" },
          { type: "named", name: "--token", isRequired: true },
          { type: "positional", description: "Workspace slug." },
        ],
      },
    ]);

    const supplied = resolveMcpLaunch({
      source: { kind: "server.json", document },
      config: {
        NOTES_DIR: "/home/user/notes",
        TEAM_NOTES_TOKEN: "s3cret",
        token: "t0ken",
        argument_3: "acme",
      },
    });
    expect(supplied.ok && supplied.launch).toEqual({
      command: "npx",
      args: ["-y", "@acme/team-notes-mcp@1.4.2", "--stdio", "--token", "t0ken", "acme"],
      // The fixed and templated values come through without a field; the token is configured.
      env: {
        TEAM_NOTES_REGION: "eu",
        TEAM_NOTES_HOME: "/home/user/notes",
        TEAM_NOTES_TOKEN: "s3cret",
      },
    });

    // An unsupplied argument that is required stops the launch; an optional one is omitted.
    const missing = resolveMcpLaunch({
      source: { kind: "server.json", document },
      config: { NOTES_DIR: "/home/user/notes", TEAM_NOTES_TOKEN: "s3cret" },
    });
    expect(missing).toEqual({ ok: false, message: "Set Token before this MCP server can start." });

    const withoutOptional = resolveMcpLaunch({
      source: { kind: "server.json", document },
      config: {
        NOTES_DIR: "/home/user/notes",
        TEAM_NOTES_TOKEN: "s3cret",
        token: "t0ken",
      },
    });
    expect(withoutOptional.ok && withoutOptional.launch.args).toEqual([
      "-y",
      "@acme/team-notes-mcp@1.4.2",
      "--stdio",
      "--token",
      "t0ken",
    ]);
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
      // Docker reads the values from its client's env, so each one is passed through by name.
      args: ["run", "-i", "--rm", "-e", "TEAM_NOTES_TOKEN", "ghcr.io/acme/notes:1"],
      env: { TEAM_NOTES_TOKEN: "s3cret" },
    });

    // A runtime argument configures the runner, so it comes before the image, not after it.
    const withRuntime = resolveMcpLaunch({
      source: {
        kind: "server.json",
        document: serverJson([
          {
            registryType: "oci",
            identifier: "ghcr.io/acme/notes:1",
            transport: { type: "stdio" },
            runtimeArguments: [
              { type: "named", name: "--network", value: "host" },
              { type: "positional", value: "{EXTRA_FLAG}" },
            ],
            packageArguments: [{ type: "named", name: "--verbose", value: "1" }],
          },
        ]),
      },
      config: { EXTRA_FLAG: "detach" },
    });
    expect(withRuntime.ok && withRuntime.launch.args).toEqual([
      "run",
      "-i",
      "--rm",
      "--network",
      "host",
      "detach",
      "ghcr.io/acme/notes:1",
      "--verbose",
      "1",
    ]);
  });

  it("launches an MCPB manifest from its bundle directory", () => {
    const resolved = resolveMcpLaunch(
      {
        source: { kind: "mcpb", manifest: mcpbManifest, bundleDir: "/opt/acme-notes" },
        // A label with a space stays one argument; the array's element is the unit, not a word.
        config: { data_dir: "/home/user/acme", token: "t0ken", labels: ["a", "b c"] },
      },
      { home: "/home/user" },
    );
    expect(resolved).toEqual({
      ok: true,
      launch: {
        command: "node",
        args: ["/opt/acme-notes/dist/index.js", "--data", "/home/user/acme", "a", "b c"],
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

describe("isValidMcpToolName", () => {
  it("accepts lowercase prefixes and rejects the rest", () => {
    expect(isValidMcpToolName("acme_notes")).toBe(true);
    expect(isValidMcpToolName("Acme")).toBe(false);
    expect(isValidMcpToolName("1acme")).toBe(false);
    expect(isValidMcpToolName("acme notes")).toBe(false);
  });
});
