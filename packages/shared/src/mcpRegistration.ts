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
  /** An MCPB list field, such as several allowed directories. */
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
const asStrings = (value: unknown): ReadonlyArray<string> =>
  asArray(value).flatMap((item) => (typeof item === "string" ? [item] : []));

const labelOf = (key: string) =>
  key
    .split(/[._-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

// server.json value templates name their variables as `{key}`.
const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/gu;

const placeholderKeys = (template: string) => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]!)),
];

const substitute = (template: string, values: ReadonlyMap<string, string>) =>
  template.replaceAll(PLACEHOLDER, (match, key: string) => values.get(key) ?? match);

/** One server.json input: an environment variable, an argument, or a template variable. */
const readInputField = (
  key: string,
  input: Readonly<Record<string, unknown>> | undefined,
  label: string,
): McpConfigField => {
  const format = asString(input?.format);
  const choices = asStrings(input?.choices);
  const description = asString(input?.description);
  const type: McpConfigValueType =
    choices.length > 0
      ? "choice"
      : format === "number"
        ? "number"
        : format === "boolean"
          ? "boolean"
          : format === "filepath"
            ? "path"
            : "string";
  // server.json writes every default as text; the form edits numbers and booleans as such.
  const text = asString(input?.default);
  const defaultValue =
    text === undefined
      ? undefined
      : type === "number"
        ? text.trim() !== "" && Number.isFinite(Number(text))
          ? Number(text)
          : undefined
        : type === "boolean"
          ? text === "true"
          : text;
  return {
    key,
    label,
    ...(description === undefined ? {} : { description }),
    type,
    required: asBoolean(input?.isRequired) ?? false,
    secret: asBoolean(input?.isSecret) ?? false,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(choices.length === 0 ? {} : { choices }),
  };
};

/** A server.json value: fixed, a template over `variables`, or left to the user under `key`. */
interface ServerJsonValue {
  readonly key: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly template?: string | undefined;
  readonly variables: Readonly<Record<string, unknown>>;
}

const valueFields = (value: ServerJsonValue, label: string): ReadonlyArray<McpConfigField> =>
  value.template === undefined
    ? [readInputField(value.key, value.input, label)]
    : placeholderKeys(value.template).map((key) =>
        readInputField(key, asRecord(value.variables[key]), labelOf(key)),
      );

const resolveValue = (value: ServerJsonValue, values: ReadonlyMap<string, string>) =>
  value.template === undefined ? (values.get(value.key) ?? "") : substitute(value.template, values);

interface ServerJsonArgument extends ServerJsonValue {
  /** `--flag` for a named argument; absent for a positional one. */
  readonly flag?: string | undefined;
  /** A named argument with neither a value nor a value hint is passed as a bare flag. */
  readonly bare: boolean;
}

const readArguments = (raw: unknown): ReadonlyArray<ServerJsonArgument> =>
  asArray(raw).flatMap((item, index) => {
    const input = asRecord(item);
    if (input === undefined) return [];
    const flag = input.type === "named" ? asString(input.name) : undefined;
    if (input.type === "named" && flag === undefined) return [];
    const template = asString(input.value);
    const hint = asString(input.valueHint);
    const key =
      hint ?? (flag === undefined ? `argument_${index + 1}` : flag.replaceAll(/^-+/gu, ""));
    return [
      {
        key,
        input,
        template,
        variables: asRecord(input.variables) ?? {},
        flag,
        bare: flag !== undefined && template === undefined && hint === undefined,
      },
    ];
  });

const argumentFields = (argument: ServerJsonArgument) =>
  argument.bare ? [] : valueFields(argument, labelOf(argument.key));

const argumentArgs = (argument: ServerJsonArgument, values: ReadonlyMap<string, string>) => {
  const flag = argument.flag === undefined ? [] : [argument.flag];
  if (argument.bare) return flag;
  const value = resolveValue(argument, values);
  // An unset optional value drops its flag too, rather than passing a dangling one.
  return value === "" ? [] : [...flag, value];
};

interface ServerJsonEnvironmentVariable extends ServerJsonValue {
  readonly name: string;
}

const readEnvironmentVariables = (raw: unknown): ReadonlyArray<ServerJsonEnvironmentVariable> =>
  asArray(raw).flatMap((item) => {
    const input = asRecord(item);
    const name = asString(input?.name)?.trim();
    if (input === undefined || name === undefined || name === "") return [];
    return [
      {
        name,
        key: name,
        input,
        template: asString(input.value),
        variables: asRecord(input.variables) ?? {},
      },
    ];
  });

/** Inputs can share a variable; the first describes it, and any secret declaration keeps it secret. */
const dedupeFields = (fields: ReadonlyArray<McpConfigField>): ReadonlyArray<McpConfigField> => {
  const byKey = new Map<string, McpConfigField>();
  for (const field of fields) {
    const seen = byKey.get(field.key);
    byKey.set(
      field.key,
      seen === undefined ? field : { ...seen, secret: seen.secret || field.secret },
    );
  }
  return [...byKey.values()];
};

interface ServerJsonPackage {
  readonly command: string;
  /** The runner's own arguments; the last one is the package identifier or image. */
  readonly baseArgs: ReadonlyArray<string>;
  /** Docker passes env values through by name, so it needs `-e` for each configured one. */
  readonly container: boolean;
  readonly runtimeArguments: ReadonlyArray<ServerJsonArgument>;
  readonly packageArguments: ReadonlyArray<ServerJsonArgument>;
  readonly environmentVariables: ReadonlyArray<ServerJsonEnvironmentVariable>;
}

const readServerJsonPackage = (
  raw: unknown,
): { readonly ok: true; readonly value: ServerJsonPackage } | McpRegistrationFailure => {
  const entry = asRecord(raw);
  if (entry === undefined) return failure("A package in server.json is not an object.");
  const transportType = asString(asRecord(entry.transport)?.type);
  if (transportType !== "stdio") {
    return failure(
      "T3 Code runs MCP servers itself, so only a stdio package is supported. This package uses " +
        `${transportType ?? "no declared transport"}.`,
    );
  }
  const registryType = asString(entry.registryType);
  const identifier = asString(entry.identifier)?.trim();
  if (identifier === undefined || identifier === "") {
    return failure("The package has no identifier.");
  }
  const version = asString(entry.version)?.trim() ?? "";
  const runtimeHint = asString(entry.runtimeHint);
  let command: string;
  let baseArgs: ReadonlyArray<string>;
  switch (registryType) {
    case "npm":
      command = runtimeHint ?? "npx";
      baseArgs = [
        ...(runtimeHint === undefined ? ["-y"] : []),
        version === "" ? identifier : `${identifier}@${version}`,
      ];
      break;
    case "pypi":
      command = runtimeHint ?? "uvx";
      baseArgs = [version === "" ? identifier : `${identifier}==${version}`];
      break;
    case "oci":
      command = runtimeHint ?? "docker";
      baseArgs = ["run", "-i", "--rm", identifier];
      break;
    default:
      return failure(
        `Unsupported package registryType ${registryType ?? "(missing)"}. Supported: npm, pypi, oci.`,
      );
  }
  return {
    ok: true,
    value: {
      command,
      baseArgs,
      container: registryType === "oci",
      runtimeArguments: readArguments(entry.runtimeArguments),
      packageArguments: readArguments(entry.packageArguments),
      environmentVariables: readEnvironmentVariables(entry.environmentVariables),
    },
  };
};

/** The first package T3 can run, or why none can be. */
const firstServerJsonPackage = (
  document: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: ServerJsonPackage } | McpRegistrationFailure => {
  const packages = asArray(document.packages);
  if (packages.length === 0) {
    return failure(
      "server.json has no packages to run. T3 Code runs MCP servers itself, so remote servers are not supported.",
    );
  }
  let firstFailure: McpRegistrationFailure | undefined;
  for (const candidate of packages) {
    const parsed = readServerJsonPackage(candidate);
    if (parsed.ok) return parsed;
    firstFailure ??= parsed;
  }
  return firstFailure!;
};

const parseServerJson = (document: Readonly<Record<string, unknown>>): McpRegistrationResult => {
  const name = asString(document.name)?.trim();
  if (name === undefined || name === "") return failure("server.json has no name.");
  const parsed = firstServerJsonPackage(document);
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  const description = asString(document.description)?.trim();
  return {
    ok: true,
    registration: {
      name,
      ...(description === undefined || description === "" ? {} : { description }),
      sourceKind: "server.json",
      fields: dedupeFields([
        ...value.environmentVariables.flatMap((variable) => valueFields(variable, variable.name)),
        ...value.runtimeArguments.flatMap(argumentFields),
        ...value.packageArguments.flatMap(argumentFields),
      ]),
    },
  };
};

const readMcpbFields = (raw: unknown): ReadonlyArray<McpConfigField> =>
  Object.entries(asRecord(raw) ?? {}).flatMap(([key, entry]): ReadonlyArray<McpConfigField> => {
    const config = asRecord(entry);
    if (config === undefined) return [];
    const declared = asString(config.type);
    const description = asString(config.description);
    const defaultValue = Array.isArray(config.default)
      ? asStrings(config.default)
      : (asString(config.default) ?? asNumber(config.default) ?? asBoolean(config.default));
    const common = {
      key,
      label: asString(config.title) ?? labelOf(key),
      ...(description === undefined ? {} : { description }),
      required: asBoolean(config.required) ?? false,
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
    };
    // A secret is stored as one string, so a sensitive field is always a single string field.
    if (asBoolean(config.sensitive) === true) {
      return [{ ...common, type: "string", secret: true }];
    }
    const min = asNumber(config.min);
    const max = asNumber(config.max);
    return [
      {
        ...common,
        type:
          declared === "boolean"
            ? "boolean"
            : declared === "number"
              ? "number"
              : declared === "file" || declared === "directory"
                ? "path"
                : "string",
        secret: false,
        ...(asBoolean(config.multiple) === true ? { multiple: true } : {}),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      },
    ];
  });

const parseMcpb = (manifest: Readonly<Record<string, unknown>>): McpRegistrationResult => {
  const command = asString(asRecord(asRecord(manifest.server)?.mcp_config)?.command);
  if (command === undefined || command.trim() === "") {
    return failure("The MCPB manifest has no server.mcp_config command.");
  }
  const name = (asString(manifest.display_name) ?? asString(manifest.name))?.trim();
  if (name === undefined || name === "") return failure("The MCPB manifest has no name.");
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
  return (
    server !== undefined &&
    (asRecord(server.mcp_config) !== undefined || asString(value.manifest_version) !== undefined)
  );
};

/** Detects the format and returns the server's identity plus the settings it needs from the user. */
export function parseMcpRegistration(json: unknown): McpRegistrationResult {
  const document = asRecord(json);
  if (document === undefined) {
    return failure("Paste a server.json document or an MCPB manifest.json object.");
  }
  return isMcpb(document) ? parseMcpb(document) : parseServerJson(document);
}

/** Each field's launch text: the configured value, else its default, else empty. */
const configuredValues = (
  fields: ReadonlyArray<McpConfigField>,
  config: Readonly<Record<string, McpConfigValue>>,
): { readonly ok: true; readonly values: ReadonlyMap<string, string> } | McpRegistrationFailure => {
  const values = new Map<string, string>();
  for (const field of fields) {
    const value = config[field.key] ?? field.default;
    const text = value === undefined ? "" : Array.isArray(value) ? value.join(",") : String(value);
    if (text === "" && field.required) {
      return failure(`Set ${field.label} before this MCP server can start.`);
    }
    values.set(field.key, text);
  }
  return { ok: true, values };
};

interface LaunchEntry {
  readonly source:
    | { readonly kind: "server.json"; readonly document: unknown }
    | { readonly kind: "mcpb"; readonly manifest: unknown; readonly bundleDir: string };
  readonly config: Readonly<Record<string, McpConfigValue>>;
}

// MCPB templates: `${__dirname}`, `${HOME}` and its folders, and `${user_config.KEY}`.
const MCPB_SUBSTITUTION = /\$\{([A-Za-z0-9_./-]+)\}/gu;
const MCPB_LIST_ARGUMENT = /^\$\{user_config\.([A-Za-z0-9_./-]+)\}$/u;

const resolveMcpbLaunch = (
  source: Extract<LaunchEntry["source"], { kind: "mcpb" }>,
  fields: ReadonlyArray<McpConfigField>,
  config: Readonly<Record<string, McpConfigValue>>,
  values: ReadonlyMap<string, string>,
  home: string,
): McpLaunchResult => {
  const mcpConfig = asRecord(asRecord(asRecord(source.manifest)?.server)?.mcp_config) ?? {};
  const builtIns = new Map([
    ["__dirname", source.bundleDir],
    ["HOME", home],
    ["DESKTOP", `${home}/Desktop`],
    ["DOCUMENTS", `${home}/Documents`],
    ["DOWNLOADS", `${home}/Downloads`],
  ]);
  const builtIn = (template: string) =>
    template.replaceAll(MCPB_SUBSTITUTION, (match, key: string) => builtIns.get(key) ?? match);
  const secret = new Set(fields.flatMap((field) => (field.secret ? [field.key] : [])));
  // A default such as `${HOME}/Desktop` resolves too; a secret is passed exactly as typed.
  const filled = new Map(
    [...values].map(([key, value]) => [key, secret.has(key) ? value : builtIn(value)]),
  );
  const fill = (template: string) =>
    template.replaceAll(MCPB_SUBSTITUTION, (match, key: string) =>
      key.startsWith("user_config.")
        ? (filled.get(key.slice("user_config.".length)) ?? "")
        : (builtIns.get(key) ?? match),
    );
  const defaults = new Map(fields.map((field) => [field.key, field.default]));
  const args = asStrings(mcpConfig.args).flatMap((arg) => {
    // A list field given as a whole argument becomes one argument per item.
    const listKey = MCPB_LIST_ARGUMENT.exec(arg)?.[1];
    const list = listKey === undefined ? undefined : (config[listKey] ?? defaults.get(listKey));
    return Array.isArray(list) ? list.map(builtIn) : [fill(arg)];
  });
  const env = Object.fromEntries(
    Object.entries(asRecord(mcpConfig.env) ?? {}).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, fill(value)] as const] : [],
    ),
  );
  return {
    ok: true,
    launch: { command: fill(asString(mcpConfig.command) ?? ""), args, env },
  };
};

const resolveServerJsonLaunch = (
  document: unknown,
  values: ReadonlyMap<string, string>,
): McpLaunchResult => {
  const parsed = firstServerJsonPackage(asRecord(document) ?? {});
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  const env = Object.fromEntries(
    value.environmentVariables.flatMap((variable) => {
      const resolved = resolveValue(variable, values);
      return resolved === "" ? [] : [[variable.name, resolved] as const];
    }),
  );
  const args = [
    ...value.baseArgs.slice(0, -1),
    // Docker takes each variable's value from its own env, so each one needs `-e` before the image.
    ...(value.container ? Object.keys(env).flatMap((name) => ["-e", name]) : []),
    // Runtime arguments configure the runner, so they precede the package identifier or image.
    ...value.runtimeArguments.flatMap((argument) => argumentArgs(argument, values)),
    ...value.baseArgs.slice(-1),
    ...value.packageArguments.flatMap((argument) => argumentArgs(argument, values)),
  ];
  return { ok: true, launch: { command: value.command, args, env } };
};

/** The process to launch for a registered server, with the user's values substituted in. */
export function resolveMcpLaunch(entry: LaunchEntry, options: { readonly home: string }) {
  const parsed = parseMcpRegistration(
    entry.source.kind === "server.json" ? entry.source.document : entry.source.manifest,
  );
  if (!parsed.ok) return parsed;
  const { fields } = parsed.registration;
  const resolved = configuredValues(fields, entry.config);
  if (!resolved.ok) return resolved;
  return entry.source.kind === "mcpb"
    ? resolveMcpbLaunch(entry.source, fields, entry.config, resolved.values, options.home)
    : resolveServerJsonLaunch(entry.source.document, resolved.values);
}

const MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;
export const isValidMcpToolName = (value: string) =>
  MCP_TOOL_NAME_PATTERN.test(value) && value.length <= 40;
