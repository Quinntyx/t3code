import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const decodeJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeExit(Schema.fromJsonString(schema));
  return (input: string) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const stripJsonSyntax = (input: string): string => {
  // Match comments together so URLs stay inside blocks; whitespace keeps adjacent tokens apart.
  const withoutComments = input.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, stringLiteral: string | undefined) => (stringLiteral ? match : " "),
  );

  return withoutComments.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, stringLiteral: string | undefined, bracket: string | undefined) =>
      stringLiteral ? match : (bracket ?? ""),
  );
};

const parseLenientJsonGetter = SchemaGetter.transformEffect((input: string) =>
  decodeJsonString(stripJsonSyntax(input)).pipe(Effect.mapError((error) => error.issue)),
);

/** Decodes JSON written for humans: comments and trailing commas are dropped before parsing. */
export const parseLenientJson = (input: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(stripJsonSyntax(input)) as unknown);
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error));
  }
};

const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  SchemaGetter.stringifyJson(),
);

const prettyJsonString = SchemaGetter.parseJson<string>().pipe(
  SchemaGetter.compose(SchemaGetter.stringifyJson({ space: 2 })),
);

export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));

const findJsonObjectEnd = (text: string, start: number): number | null => {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
};

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  const end = findJsonObjectEnd(trimmed, start);
  return end === null ? trimmed.slice(start) : trimmed.slice(start, end + 1);
}

export interface JsonObjectCandidates {
  /** Complete objects in reply order, last first: the final one is the likely answer. */
  readonly complete: ReadonlyArray<string>;
  /** An object that never closed, so the reply was probably truncated. */
  readonly truncated: string | undefined;
}

export function extractJsonObjectCandidates(raw: string): JsonObjectCandidates {
  const trimmed = raw.trim();
  const complete: string[] = [];
  let truncated: string | undefined;
  let cursor = 0;
  while (cursor < trimmed.length) {
    const start = trimmed.indexOf("{", cursor);
    if (start < 0) break;
    const end = findJsonObjectEnd(trimmed, start);
    if (end === null) {
      truncated = trimmed.slice(start);
      break;
    }
    complete.push(trimmed.slice(start, end + 1));
    cursor = end + 1;
  }
  return { complete: complete.reverse(), truncated };
}

export const fromJsonStringPretty = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(schema).pipe(
    Schema.encode({
      decode: prettyJsonString,
      encode: prettyJsonString,
    }),
  );
