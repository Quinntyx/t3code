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
  readonly placeholder?: string | undefined;
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
  readonly repeated: boolean;
  /** A fixed value, or a template over the entry's `variables`; absent leaves it to the user. */
  readonly value?: string | undefined;
  /** What server.json declares about the placeholders in `value`, keyed by config key. */
  readonly variables: Readonly<Record<string, unknown>>;
  /** Set when the entry declares a value the user supplies instead of carrying one itself. */
  readonly suppliedKey?: string | undefined;
  /** That entry, which declares the field the same way a variable does. */
  readonly supplied?: Readonly<Record<string, unknown>> | undefined;
}

// Value placeholders in either format name a config field; a missing one is substituted empty.
const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/gu;

const placeholderKeys = (template: string) => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]!)),
];

/** A named flag's `--token` becomes the config key `token`; a positional gets its position. */
const argumentKey = (name: string | undefined, index: number) => {
  const key =
    name === undefined ? "" : name.replaceAll(/^-+/gu, "").replaceAll(/[^A-Za-z0-9_-]+/gu, "_");
  return key === "" ? `argument_${index + 1}` : key;
};

/** These declarations mean the entry asks the user for a value rather than carrying one. */
const declaresSuppliedValue = (entry: Readonly<Record<string, unknown>>) =>
  asString(entry.valueHint) !== undefined ||
  asBoolean(entry.isRequired) !== undefined ||
  asBoolean(entry.isSecret) !== undefined ||
  asBoolean(entry.isRepeated) === true ||
  asString(entry.description) !== undefined ||
  asString(entry.default) !== undefined ||
  asString(entry.format) !== undefined ||
  asArray(entry.choices).length > 0;

const readArgument = (raw: unknown, index: number): NormalizedArgument | undefined => {
  const entry = asRecord(raw);
  if (entry === undefined) return undefined;
  const named = entry.type === "named";
  const name = named ? asString(entry.name) : undefined;
  if (named && name === undefined) return undefined;
  const repeated = asBoolean(entry.isRepeated) === true;
  const base = { type: named ? ("named" as const) : ("positional" as const), name, repeated };
  const value = asString(entry.value);
  if (value !== undefined) {
    return { ...base, value, variables: asRecord(entry.variables) ?? {} };
  }
  // Without a value a named argument is a bare flag; a positional one adds nothing.
  if (!declaresSuppliedValue(entry)) {
    return named ? { ...base, variables: {} } : undefined;
  }
  const key = argumentKey(name, index);
  return {
    ...base,
    variables: {},
    suppliedKey: key,
    supplied: { ...entry, isRepeated: repeated },
  };
};

const readArguments = (raw: unknown): ReadonlyArray<NormalizedArgument> =>
  asArray(raw).flatMap((entry, index) => {
    const argument = readArgument(entry, index);
    return argument === undefined ? [] : [argument];
  });

const substitute = (template: string, values: ReadonlyMap<string, string>) =>
  template.replaceAll(PLACEHOLDER, (match, key: string) => values.get(key) ?? match);

/** An environment variable and an argument variable are the same server.json input shape. */
const readVariableField = (
  key: string,
  variable: Readonly<Record<string, unknown>> | undefined,
  fallback: { readonly label: string; readonly description?: string | undefined },
): McpConfigField => {
  const format = variable === undefined ? undefined : asString(variable.format);
  const choices = asArray(variable?.choices).flatMap((choice) => {
    const value = asString(choice);
    return value === undefined ? [] : [value];
  });
  const description =
    (variable === undefined ? undefined : asString(variable.description)) ?? fallback.description;
  const placeholder = variable === undefined ? undefined : asString(variable.placeholder);
  return {
    key,
    label: fallback.label,
    ...(description === undefined ? {} : { description }),
    ...(placeholder === undefined ? {} : { placeholder }),
    type:
      choices.length > 0
        ? "choice"
        : format === "number"
          ? "number"
          : format === "boolean"
            ? "boolean"
            : format !== undefined && /path|file|directory/iu.test(format)
              ? "path"
              : "string",
    required: (variable === undefined ? undefined : asBoolean(variable.isRequired)) ?? false,
    secret: (variable === undefined ? undefined : asBoolean(variable.isSecret)) ?? false,
    ...(variable === undefined || asString(variable.default) === undefined
      ? {}
      : { default: asString(variable.default) }),
    ...(choices.length === 0 ? {} : { choices }),
  };
};

interface NormalizedEnvironmentVariable {
  readonly name: string;
  /** A fixed value or a template over `variables`; absent leaves the value to the user. */
  readonly value?: string | undefined;
  readonly variables: Readonly<Record<string, unknown>>;
  /** The entry itself, which declares a value the user supplies the same way a variable does. */
  readonly entry: Readonly<Record<string, unknown>>;
}

const readEnvironmentVariables = (raw: unknown): ReadonlyArray<NormalizedEnvironmentVariable> =>
  asArray(raw).flatMap((raw) => {
    const entry = asRecord(raw);
    const name = entry === undefined ? undefined : asString(entry.name);
    if (entry === undefined || name === undefined || name.trim() === "") return [];
    const value = asString(entry.value);
    return [
      {
        name,
        ...(value === undefined ? {} : { value }),
        variables: asRecord(entry.variables) ?? {},
        entry,
      },
    ];
  });

/** A fixed value needs no field; a template asks for each variable it names. */
const environmentVariableFields = (
  variables: ReadonlyArray<NormalizedEnvironmentVariable>,
): ReadonlyArray<McpConfigField> =>
  variables.flatMap((variable) =>
    variable.value === undefined
      ? [readVariableField(variable.name, variable.entry, { label: variable.name })]
      : placeholderKeys(variable.value).map((key) =>
          readVariableField(key, asRecord(variable.variables[key]), { label: labelOf(key) }),
        ),
  );

// Several inputs can declare one variable; a secret or required declaration in any of them wins.
const mergeFieldsByKey = (fields: ReadonlyArray<McpConfigField>): ReadonlyArray<McpConfigField> => {
  const byKey = new Map<string, McpConfigField>();
  for (const field of fields) {
    const seen = byKey.get(field.key);
    if (seen === undefined) {
      byKey.set(field.key, field);
      continue;
    }
    const merged = { ...seen } as Record<string, unknown>;
    for (const [key, value] of Object.entries(field)) {
      // The first declaration owns how a field is described; later ones only fill in constraints.
      if (key === "description" || key === "placeholder") continue;
      if (value !== undefined && !Object.hasOwn(merged, key)) merged[key] = value;
    }
    byKey.set(field.key, {
      ...merged,
      type: seen.type === "string" && field.type !== "string" ? field.type : seen.type,
      secret: seen.secret || field.secret,
      required: seen.required || field.required,
    } as McpConfigField);
  }
  return [...byKey.values()];
};

const readArgumentFields = (
  argumentsList: ReadonlyArray<NormalizedArgument>,
  prefix: string,
): ReadonlyArray<McpConfigField> =>
  argumentsList.flatMap((argument, index) => {
    const described =
      argument.type === "named"
        ? `Value for ${argument.name ?? ""} (${prefix} ${index + 1}).`
        : `Positional value ${index + 1}.`;
    if (argument.suppliedKey !== undefined) {
      const supplied = argument.supplied ?? {};
      return [
        {
          ...readVariableField(argument.suppliedKey, supplied, {
            label: labelOf(asString(supplied.valueHint) ?? argument.suppliedKey),
            // The entry's own description wins over the positional or flag it belongs to.
            description: described,
          }),
          ...(argument.repeated ? { multiple: true } : {}),
        },
      ];
    }
    return placeholderKeys(argument.value ?? "").map((key) => ({
      ...readVariableField(key, asRecord(argument.variables[key]), {
        label: labelOf(key),
        description: described,
      }),
      ...(argument.repeated ? { multiple: true } : {}),
    }));
  });

const SUPPORTED_REGISTRY_TYPES = new Set(["npm", "pypi", "oci"]);

interface ParsedServerJsonPackage {
  readonly command: string;
  readonly baseArgs: ReadonlyArray<string>;
  /** Docker passes env values through by name, so it needs `-e` for each configured one. */
  readonly container: boolean;
  readonly runtimeArguments: ReadonlyArray<NormalizedArgument>;
  readonly packageArguments: ReadonlyArray<NormalizedArgument>;
  readonly environmentVariables: ReadonlyArray<NormalizedEnvironmentVariable>;
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
  if (asString(entry.registryBaseUrl) !== undefined) {
    return failure(
      "registryBaseUrl is not supported; T3 uses the default registry for this package type.",
    );
  }
  const runtimeArguments = readArguments(entry.runtimeArguments);
  const packageArguments = readArguments(entry.packageArguments);
  if (
    [...runtimeArguments, ...packageArguments].some(
      (argument) => argument.repeated && argument.value !== undefined,
    )
  ) {
    return failure("A repeated argument with a fixed value or variables is not supported.");
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
      container: registryType === "oci",
      runtimeArguments,
      packageArguments,
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
    const fields = mergeFieldsByKey([
      ...environmentVariableFields(value.environmentVariables),
      ...readArgumentFields(value.runtimeArguments, "runtime argument"),
      ...readArgumentFields(value.packageArguments, "package argument"),
    ]);
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
  Object.entries(asRecord(raw) ?? {}).flatMap(([key, entry]): ReadonlyArray<McpConfigField> => {
    const config = asRecord(entry);
    if (config === undefined) return [];
    const declared = asString(config.type);
    const choices = asArray(config.choices).flatMap((choice) => {
      const value = asString(choice);
      return value === undefined ? [] : [value];
    });
    const defaultArray = asArray(config.default).flatMap((entry) => {
      const value = asString(entry);
      return value === undefined ? [] : [value];
    });
    const defaultValue =
      defaultArray.length > 0
        ? defaultArray
        : (asString(config.default) ?? asNumber(config.default) ?? asBoolean(config.default));
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
    const label = asString(config.title) ?? labelOf(key);
    const description = asString(config.description);
    const placeholder = asString(config.placeholder);
    const required = asBoolean(config.required) ?? false;
    // A secret is stored only as a string, so a sensitive field is always a secret string field.
    if (asBoolean(config.sensitive) === true) {
      const secretDefault = asString(config.default);
      return [
        {
          key,
          label,
          ...(description === undefined ? {} : { description }),
          ...(placeholder === undefined ? {} : { placeholder }),
          type: "string" as const,
          required,
          secret: true,
          ...(secretDefault === undefined ? {} : { default: secretDefault }),
        },
      ];
    }
    return [
      {
        key,
        label,
        ...(description === undefined ? {} : { description }),
        ...(placeholder === undefined ? {} : { placeholder }),
        type,
        required,
        secret: false,
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
        ...(choices.length === 0 ? {} : { choices }),
        ...(asBoolean(config.multiple) === true ? { multiple: true } : {}),
        ...(asNumber(config.min) === undefined ? {} : { min: asNumber(config.min) }),
        ...(asNumber(config.max) === undefined ? {} : { max: asNumber(config.max) }),
      },
    ];
  });

const MCPB_USER_CONFIG_TYPES = new Set(["string", "number", "boolean", "directory", "file"]);

const mcpbConfigReferences = (mcpConfig: Readonly<Record<string, unknown>>) =>
  [...JSON.stringify(mcpConfig).matchAll(/\$\{user_config(\.([A-Za-z0-9_.-]+))?\}/gu)].map(
    (match) => ({ bare: match[1] === undefined, key: match[2] }),
  );

const parseMcpb = (manifest: Readonly<Record<string, unknown>>): McpRegistrationResult => {
  const server = asRecord(manifest.server);
  const mcpConfig = server === undefined ? undefined : asRecord(server.mcp_config);
  const command = mcpConfig === undefined ? undefined : asString(mcpConfig.command);
  if (mcpConfig === undefined || command === undefined || command.trim() === "") {
    return failure(
      asString(server?.type) === "uv"
        ? "MCPB uv servers are not supported without an explicit server.mcp_config command."
        : "The MCPB manifest has no server.mcp_config command.",
    );
  }
  const userConfig = asRecord(manifest.user_config) ?? {};
  for (const [key, entry] of Object.entries(userConfig)) {
    const config = asRecord(entry);
    const declared = config === undefined ? undefined : asString(config.type);
    if (declared === undefined || !MCPB_USER_CONFIG_TYPES.has(declared)) {
      return failure(`Unsupported user_config type ${declared ?? "(missing)"} for ${key}.`);
    }
  }
  for (const reference of mcpbConfigReferences(mcpConfig)) {
    if (reference.bare) {
      return failure("Bare ${user_config} substitution is not supported; use ${user_config.KEY}.");
    }
    if (!Object.hasOwn(userConfig, reference.key!)) {
      return failure(`Unknown user_config key ${reference.key} referenced by server.mcp_config.`);
    }
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
      // A declared but unset field substitutes empty, so its whole optional flag drops out.
      values.set(field.key, "");
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
  /** The directory `${HOME}` and its well-known children resolve to. */
  readonly home?: string | undefined;
  /** The host platform `platform_overrides` and `${pathSeparator}` follow. */
  readonly platform?: string | undefined;
}

const mcpbSubstitutions = (
  bundleDir: string,
  options: McpLaunchOptions,
): ReadonlyMap<string, string> => {
  const home = options.home ?? "";
  const separator = options.platform === "win32" ? "\\" : "/";
  return new Map([
    ["__dirname", bundleDir],
    ["HOME", home],
    ["DESKTOP", `${home}/Desktop`],
    ["DOCUMENTS", `${home}/Documents`],
    ["DOWNLOADS", `${home}/Downloads`],
    ["pathSeparator", separator],
    ["/", separator],
  ]);
};

const MCPB_SUBSTITUTION = /\$\{([A-Za-z0-9_./]+)\}/gu;

const substituteMcpb = (
  template: string,
  values: ReadonlyMap<string, string>,
  substitutions: ReadonlyMap<string, string>,
) =>
  template.replaceAll(MCPB_SUBSTITUTION, (match, key: string) =>
    key.startsWith("user_config.")
      ? (values.get(key.slice("user_config.".length)) ?? "")
      : (substitutions.get(key) ?? match),
  );

/** An argv element that is only a multi-value placeholder becomes one argument per value. */
const MCPB_ARGUMENT_PLACEHOLDER = /^\$\{user_config\.([A-Za-z0-9_.-]+)\}$/u;

/**
 * The arguments one declared argument contributes. A fixed value always comes through, a
 * template whose placeholders are all unset leaves no dangling flag, and a bare flag still goes.
 */
const argumentArgs = (
  argument: NormalizedArgument,
  values: ReadonlyMap<string, string>,
  config: Readonly<Record<string, McpConfigValue>>,
): ReadonlyArray<string> => {
  const flag = argument.type === "named" ? [argument.name!] : [];
  if (argument.suppliedKey !== undefined) {
    const supplied = values.get(argument.suppliedKey);
    const configured = config[argument.suppliedKey];
    // A secret list comes back from the store as comma-joined text, so only that form is split.
    const parts =
      supplied === undefined || supplied === ""
        ? []
        : Array.isArray(configured)
          ? configured.map(String)
          : argument.repeated
            ? supplied.split(",")
            : [supplied];
    return parts.flatMap((part) => [...flag, part]);
  }
  if (argument.value === undefined) return flag;
  const value = substitute(argument.value, values);
  if (value === "") return [];
  return [...flag, value];
};

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
    // The host passes its platform; a bare parser call gets a deterministic default.
    const platform = options.platform ?? "linux";
    const overrides = asRecord(asRecord(mcpConfig.platform_overrides)?.[platform]) ?? {};
    const effective = { ...mcpConfig, ...overrides };
    const command = asString(effective.command) ?? "";
    if (command.trim() === "")
      return failure("The MCPB manifest has no server.mcp_config command.");
    const substitutions = mcpbSubstitutions(entry.source.bundleDir, options);
    const secretKeys = new Set(
      parsed.registration.fields.flatMap((field) => (field.secret ? [field.key] : [])),
    );
    const fields = new Map(parsed.registration.fields.map((field) => [field.key, field]));
    const resolvedValues = new Map(
      [...values].map(([key, value]) => [
        key,
        secretKeys.has(key) ? value : substituteMcpb(value, values, substitutions),
      ]),
    );
    const args = asArray(effective.args).flatMap((arg) => {
      const value = asString(arg);
      if (value === undefined) return [];
      const placeholder = MCPB_ARGUMENT_PLACEHOLDER.exec(value);
      if (placeholder !== null) {
        const key = placeholder[1]!;
        const configured = entry.config[key] ?? fields.get(key)?.default;
        if (Array.isArray(configured)) {
          return configured.map((part) => substituteMcpb(part, resolvedValues, substitutions));
        }
      }
      return [substituteMcpb(value, resolvedValues, substitutions)];
    });
    const env = Object.entries(asRecord(effective.env) ?? {}).flatMap(([key, value]) => {
      const template = asString(value);
      return template === undefined
        ? []
        : [[key, substituteMcpb(template, resolvedValues, substitutions)] as const];
    });
    // Checked on the manifest's own templates, so a user value containing `${` is never echoed.
    const unsupported = [
      command,
      ...asArray(effective.args),
      ...Object.values(asRecord(effective.env) ?? {}),
    ]
      .flatMap((template) => [...(asString(template) ?? "").matchAll(MCPB_SUBSTITUTION)])
      .find(([, key]) => !key!.startsWith("user_config.") && !substitutions.has(key!));
    if (unsupported !== undefined) {
      return failure(`Unsupported MCPB substitution: ${unsupported[0]}`);
    }
    const launchCommand = substituteMcpb(command, resolvedValues, substitutions);
    return {
      ok: true,
      launch: { command: launchCommand, args, env: Object.fromEntries(env) },
    };
  }

  const document = asRecord(entry.source.document) ?? {};
  const packages = asArray(document.packages);
  for (const candidate of packages) {
    const value = readServerJsonPackage(candidate);
    if (!value.ok) continue;
    // A fixed value needs no field, so it comes from the document; a template from its variables.
    const env = Object.fromEntries(
      value.value.environmentVariables.flatMap((variable) => {
        if (variable.value === undefined) {
          const configured = values.get(variable.name);
          return configured === undefined || configured === ""
            ? []
            : [[variable.name, configured] as const];
        }
        return [[variable.name, substitute(variable.value, values)] as const];
      }),
    );
    // Docker takes a variable's value from its own client env, so each configured one needs `-e`.
    // They go before the image, which is the last of the base args.
    const args = [
      ...value.value.baseArgs.slice(0, -1),
      ...(value.value.container ? Object.keys(env).flatMap((name) => ["-e", name]) : []),
      // Runtime arguments configure the runner, so they precede the package identifier or image.
      ...value.value.runtimeArguments.flatMap((argument) =>
        argumentArgs(argument, values, entry.config),
      ),
      ...value.value.baseArgs.slice(-1),
      ...value.value.packageArguments.flatMap((argument) =>
        argumentArgs(argument, values, entry.config),
      ),
    ].filter((argument) => argument !== "");
    return { ok: true, launch: { command: value.value.command, args, env } };
  }
  return failure("server.json has no usable stdio package.");
}

const MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;
export const isValidMcpToolName = (value: string) =>
  MCP_TOOL_NAME_PATTERN.test(value) && value.length <= 40;
