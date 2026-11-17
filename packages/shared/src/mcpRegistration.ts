import * as Predicate from "effect/Predicate";

/**
 * Parsing for MCP server definitions: the MCP Registry `server.json` and the MCPB manifest.
 * Both are untrusted JSON pasted by the user, so every read is checked here and the server
 * owns launching the process. Only local stdio servers are supported.
 */

export type McpConfigValue = string | number | boolean | ReadonlyArray<string>;

export type McpConfigValueType = "string" | "number" | "boolean" | "path" | "choice";

export interface McpConfigField {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly type: McpConfigValueType;
  readonly required: boolean;
  readonly secret: boolean;
  readonly default?: McpConfigValue | undefined;
  readonly choices?: ReadonlyArray<string> | undefined;
  readonly multiple?: boolean | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

export interface ParsedMcpRegistration {
  readonly name: string;
  readonly description?: string | undefined;
  readonly sourceKind: "server.json" | "mcpb";
  readonly fields: ReadonlyArray<McpConfigField>;
}

export type McpRegistrationFailure = {
  readonly ok: false;
  readonly message: string;
};

export type McpRegistrationResult =
  | { readonly ok: true; readonly registration: ParsedMcpRegistration }
  | McpRegistrationFailure;

export interface McpLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type McpLaunchResult =
  | { readonly ok: true; readonly launch: McpLaunch }
  | McpRegistrationFailure;

const failure = (message: string): McpRegistrationFailure => ({ ok: false, message });
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? (value as ReadonlyArray<unknown>) : [];
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const labelOf = (key: string) =>
  key
    .split(/[._-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

interface NormalizedArgument {
  readonly type: "positional" | "named";
  readonly name?: string | undefined;
  readonly value: string;
}

const readArgument = (raw: unknown): NormalizedArgument | undefined => {
  const entry = asRecord(raw);
  if (entry === undefined) return undefined;
  const value = asString(entry.value);
  if (value === undefined) return undefined;
  if (entry.type === "named") {
    const name = asString(entry.name);
    return name === undefined ? undefined : { type: "named", name, value };
  }
  return { type: "positional", value };
};

const readArguments = (raw: unknown): ReadonlyArray<NormalizedArgument> =>
  asArray(raw).flatMap((entry) => {
    const argument = readArgument(entry);
    return argument === undefined ? [] : [argument];
  });

// Value placeholders in either format name a config field; a missing one is substituted empty.
const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/gu;

const substitute = (template: string, values: ReadonlyMap<string, string>) =>
  template.replaceAll(PLACEHOLDER, (_match, key: string) => values.get(key) ?? "");

const readEnvironmentVariables = (raw: unknown): ReadonlyArray<McpConfigField> =>
  asArray(raw).flatMap((entry) => {
    const variable = asRecord(entry);
    const name = variable === undefined ? undefined : asString(variable.name);
    if (variable === undefined || name === undefined || name.trim() === "") return [];
    const format = asString(variable.format);
    const choices = asArray(variable.choices).flatMap((choice) => {
      const value = asString(choice);
      return value === undefined ? [] : [value];
    });
    return [
      {
        key: name,
        label: name,
        ...(asString(variable.description) === undefined
          ? {}
          : { description: asString(variable.description) }),
        type:
          choices.length > 0
            ? "choice"
            : format !== undefined && /path|file|directory/iu.test(format)
              ? "path"
              : "string",
        required: asBoolean(variable.isRequired) ?? false,
        secret: asBoolean(variable.isSecret) ?? false,
        ...(asString(variable.default) === undefined
          ? {}
          : { default: asString(variable.default) }),
        ...(choices.length === 0 ? {} : { choices }),
      },
    ];
  });

const readArgumentFields = (
  argumentsList: ReadonlyArray<NormalizedArgument>,
  prefix: string,
): ReadonlyArray<McpConfigField> =>
  argumentsList.flatMap((argument, index) => {
    const keys = [...argument.value.matchAll(PLACEHOLDER)].map((match) => match[1]!);
    return [...new Set(keys)].map((key) => ({
      key,
      label: labelOf(key),
      description:
        argument.type === "named"
          ? `Value for ${argument.name ?? ""} (${prefix} ${index + 1}).`
          : `Positional value ${index + 1}.`,
      type: "string" as const,
      required: false,
      secret: false,
    }));
  });

const SUPPORTED_REGISTRY_TYPES = new Set(["npm", "pypi", "oci"]);

interface ParsedServerJsonPackage {
  readonly command: string;
  readonly baseArgs: ReadonlyArray<string>;
  readonly runtimeArguments: ReadonlyArray<NormalizedArgument>;
  readonly packageArguments: ReadonlyArray<NormalizedArgument>;
  readonly environmentVariables: ReadonlyArray<McpConfigField>;
}

const readServerJsonPackage = (
  raw: unknown,
): { readonly ok: true; readonly value: ParsedServerJsonPackage } | McpRegistrationFailure => {
  const entry = asRecord(raw);
  if (entry === undefined) return failure("A package in server.json is not an object.");
  const transport = asRecord(entry.transport);
  const transportType = transport === undefined ? undefined : asString(transport.type);
  if (transportType !== "stdio") {
    return failure(
      "T3 Code runs MCP servers itself, so only a stdio package is supported. This package uses " +
        `${transportType ?? "no declared transport"}.`,
    );
  }
  const registryType = asString(entry.registryType);
  if (registryType === undefined || !SUPPORTED_REGISTRY_TYPES.has(registryType)) {
    return failure(
      `Unsupported package registryType ${registryType ?? "(missing)"}. Supported: npm, pypi, oci.`,
    );
  }
  const identifier = asString(entry.identifier);
  if (identifier === undefined || identifier.trim() === "") {
    return failure("The package has no identifier.");
  }
  const version = asString(entry.version);
  const runtimeHint = asString(entry.runtimeHint);
  const pinned = version === undefined || version.trim() === "" ? "" : version;
  const command =
    runtimeHint ?? (registryType === "npm" ? "npx" : registryType === "pypi" ? "uvx" : "docker");
  const baseArgs =
    registryType === "npm"
      ? runtimeHint === undefined
        ? ["-y", pinned === "" ? identifier : `${identifier}@${pinned}`]
        : [pinned === "" ? identifier : `${identifier}@${pinned}`]
      : registryType === "pypi"
        ? [pinned === "" ? identifier : `${identifier}==${pinned}`]
        : ["run", "-i", "--rm", identifier];
  return {
    ok: true,
    value: {
      command,
      baseArgs,
      runtimeArguments: readArguments(entry.runtimeArguments),
      packageArguments: readArguments(entry.packageArguments),
      environmentVariables: readEnvironmentVariables(entry.environmentVariables),
    },
  };
};

const parseServerJson = (document: Readonly<Record<string, unknown>>): McpRegistrationResult => {
  const name = asString(document.name)?.trim();
  if (name === undefined || name === "") {
    return failure("server.json has no name.");
  }
  if (asArray(document.remotes).length > 0) {
    return failure(
      "T3 Code runs MCP servers itself, so remote servers are not supported. Add a local stdio package instead.",
    );
  }
  const packages = asArray(document.packages);
  if (packages.length === 0) {
    return failure("server.json has no packages to run.");
  }
  let firstFailure: McpRegistrationFailure | undefined;
  for (const candidate of packages) {
    const parsed = readServerJsonPackage(candidate);
    if (!parsed.ok) {
      firstFailure ??= parsed;
      continue;
    }
    const { value } = parsed;
    const fields = [
      ...value.environmentVariables,
      ...readArgumentFields(value.runtimeArguments, "runtime argument"),
      ...readArgumentFields(value.packageArguments, "package argument"),
    ].filter(
      (field, index, all) => all.findIndex((candidate) => candidate.key === field.key) === index,
    );
    const description = asString(document.description)?.trim();
    return {
      ok: true,
      registration: {
        name,
        ...(description === undefined || description === "" ? {} : { description }),
        sourceKind: "server.json",
        fields,
      },
    };
  }
  return firstFailure ?? failure("server.json has no usable package.");
};

const readMcpbFields = (raw: unknown): ReadonlyArray<McpConfigField> =>
  Object.entries(asRecord(raw) ?? {}).flatMap(([key, entry]) => {
    const config = asRecord(entry);
    if (config === undefined) return [];
    const declared = asString(config.type);
    const choices = asArray(config.choices).flatMap((choice) => {
      const value = asString(choice);
      return value === undefined ? [] : [value];
    });
    const defaultValue =
      asString(config.default) ?? asNumber(config.default) ?? asBoolean(config.default);
    const type: McpConfigValueType =
      choices.length > 0
        ? "choice"
        : declared === "boolean"
          ? "boolean"
          : declared === "number"
            ? "number"
            : declared === "file" || declared === "directory"
              ? "path"
              : "string";
    return [
      {
        key,
        label: asString(config.title) ?? labelOf(key),
        ...(asString(config.description) === undefined
          ? {}
          : { description: asString(config.description) }),
        type,
        required: asBoolean(config.required) ?? false,
        secret: asBoolean(config.sensitive) ?? false,
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
        ...(choices.length === 0 ? {} : { choices }),
        ...(asBoolean(config.multiple) === true ? { multiple: true } : {}),
        ...(asNumber(config.min) === undefined ? {} : { min: asNumber(config.min) }),
        ...(asNumber(config.max) === undefined ? {} : { max: asNumber(config.max) }),
      },
    ];
  });

const parseMcpb = (manifest: Readonly<Record<string, unknown>>): McpRegistrationResult => {
  const server = asRecord(manifest.server);
  const mcpConfig = server === undefined ? undefined : asRecord(server.mcp_config);
  const command = mcpConfig === undefined ? undefined : asString(mcpConfig.command);
  if (mcpConfig === undefined || command === undefined || command.trim() === "") {
    return failure("The MCPB manifest has no server.mcp_config command.");
  }
  const rawName = asString(manifest.display_name) ?? asString(manifest.name);
  const name = rawName?.trim();
  if (name === undefined || name === "") {
    return failure("The MCPB manifest has no name.");
  }
  const description = asString(manifest.description)?.trim();
  return {
    ok: true,
    registration: {
      name,
      ...(description === undefined || description === "" ? {} : { description }),
      sourceKind: "mcpb",
      fields: readMcpbFields(manifest.user_config),
    },
  };
};

const isMcpb = (value: Readonly<Record<string, unknown>>) => {
  const server = asRecord(value.server);
  return server !== undefined && asRecord(server.mcp_config) !== undefined;
};

/** Detects the format and returns the server's identity plus the settings it needs from the user. */
export function parseMcpRegistration(json: unknown): McpRegistrationResult {
  const document = asRecord(json);
  if (document === undefined) {
    return failure("Paste a server.json document or an MCPB manifest.json object.");
  }
  return isMcpb(document) ? parseMcpb(document) : parseServerJson(document);
}

const stringifyValue = (value: McpConfigValue): string =>
  Array.isArray(value) ? value.join(",") : String(value);

const configuredValues = (
  fields: ReadonlyArray<McpConfigField>,
  config: Readonly<Record<string, McpConfigValue>>,
): { readonly ok: true; readonly values: ReadonlyMap<string, string> } | McpRegistrationFailure => {
  const values = new Map<string, string>();
  for (const field of fields) {
    const configured = config[field.key];
    const value = configured === undefined ? field.default : configured;
    if (value === undefined || value === "") {
      if (field.required) {
        return failure(`Set ${field.label} before this MCP server can start.`);
      }
      continue;
    }
    values.set(field.key, stringifyValue(value));
  }
  return { ok: true, values };
};

interface LaunchEntry {
  readonly source:
    | { readonly kind: "server.json"; readonly document: unknown }
    | { readonly kind: "mcpb"; readonly manifest: unknown; readonly bundleDir: string };
  readonly config: Readonly<Record<string, McpConfigValue>>;
}

export interface McpLaunchOptions {
  /** The home directory `${HOME}` resolves to. */
  readonly home?: string | undefined;
}

const substituteMcpb = (
  template: string,
  values: ReadonlyMap<string, string>,
  bundleDir: string,
  home: string | undefined,
) =>
  template
    .replaceAll("${__dirname}", bundleDir)
    .replaceAll("${HOME}", home ?? "")
    .replaceAll(
      /\$\{user_config\.([A-Za-z0-9_.-]+)\}/gu,
      (_match, key: string) => values.get(key) ?? "",
    );

/** The process to launch for a registered server, with the user's values substituted in. */
export function resolveMcpLaunch(
  entry: LaunchEntry,
  options: McpLaunchOptions = {},
): McpLaunchResult {
  const parsed = parseMcpRegistration(
    entry.source.kind === "server.json" ? entry.source.document : entry.source.manifest,
  );
  if (!parsed.ok) return parsed;
  const resolved = configuredValues(parsed.registration.fields, entry.config);
  if (!resolved.ok) return resolved;
  const { values } = resolved;

  if (entry.source.kind === "mcpb") {
    const manifest = asRecord(entry.source.manifest) ?? {};
    const server = asRecord(manifest.server) ?? {};
    const mcpConfig = asRecord(server.mcp_config) ?? {};
    const command = asString(mcpConfig.command) ?? "";
    if (command.trim() === "")
      return failure("The MCPB manifest has no server.mcp_config command.");
    const bundleDir = entry.source.bundleDir;
    const home = options.home;
    const args = asArray(mcpConfig.args).flatMap((arg) => {
      const value = asString(arg);
      return value === undefined ? [] : [substituteMcpb(value, values, bundleDir, home)];
    });
    const env = Object.entries(asRecord(mcpConfig.env) ?? {}).flatMap(([key, value]) => {
      const template = asString(value);
      return template === undefined
        ? []
        : [[key, substituteMcpb(template, values, bundleDir, home)] as const];
    });
    return {
      ok: true,
      launch: {
        command: substituteMcpb(command, values, bundleDir, home),
        args,
        env: Object.fromEntries(env),
      },
    };
  }

  const document = asRecord(entry.source.document) ?? {};
  const packages = asArray(document.packages);
  for (const candidate of packages) {
    const value = readServerJsonPackage(candidate);
    if (!value.ok) continue;
    const substituteValue = (template: string) => substitute(template, values);
    const args = [
      ...value.value.baseArgs,
      ...value.value.runtimeArguments.flatMap((argument) =>
        argument.type === "named"
          ? [argument.name!, substituteValue(argument.value)]
          : [substituteValue(argument.value)],
      ),
      ...value.value.packageArguments.flatMap((argument) =>
        argument.type === "named"
          ? [argument.name!, substituteValue(argument.value)]
          : [substituteValue(argument.value)],
      ),
    ].filter((argument) => argument !== "");
    const env = Object.fromEntries(
      value.value.environmentVariables.flatMap((field) => {
        const resolvedValue = values.get(field.key);
        return resolvedValue === undefined ? [] : [[field.key, resolvedValue] as const];
      }),
    );
    return { ok: true, launch: { command: value.value.command, args, env } };
  }
  return failure("server.json has no usable stdio package.");
}

/** `name` as a stable id: lowercase letters, digits and dashes. */
export function mcpServerIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug === "" ? "mcp-server" : slug;
}

const MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;

export const isValidMcpToolName = (value: string) =>
  MCP_TOOL_NAME_PATTERN.test(value) && value.length <= 40;
