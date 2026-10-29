import * as Schema from "effect/Schema";
import { RuntimeMode } from "@t3tools/contracts";

export const TEXT_LIMITS = {
  requestBytes: 96_000,
  continuationBytes: 128_000,
  responseBytes: 20_000,
  resultBytes: 32_000,
  rounds: 4,
  calls: 4,
  history: 16,
} as const;
export const TextFailureCode = Schema.Literals([
  "authority",
  "configuration",
  "provider",
  "bounds",
  "continuation",
  "reply-debt",
]);
export type TextFailureCode = typeof TextFailureCode.Type;
export class DeusTextError extends Schema.TaggedError<DeusTextError>()("DeusTextError", {
  code: TextFailureCode,
}) {
  override get message() {
    return `Deus text request failed (${this.code}); reconnect or correct the configuration and retry.`;
  }
}
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export const TextPart = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.Boolean),
  thoughtSignature: Schema.optionalKey(Schema.String),
  functionCall: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.String,
      args: JsonObject,
    }),
  ),
  functionResponse: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.String,
      response: JsonObject,
    }),
  ),
});
export type TextPart = typeof TextPart.Type;
export const TextReply = Schema.Struct({ parts: Schema.Array(TextPart) });
export type TextReply = typeof TextReply.Type;
export const TextContent = Schema.Struct({
  role: Schema.Literals(["user", "model"]),
  parts: Schema.Array(TextPart),
});
export type TextContent = typeof TextContent.Type;
export const Continuation = Schema.Struct({
  revision: Schema.Int,
  steps: Schema.Array(
    Schema.Struct({
      reply: TextReply,
      runtimeMode: RuntimeMode,
      actionIds: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
        Schema.isMaxLength(TEXT_LIMITS.calls),
      ),
      results: Schema.Array(JsonObject),
    }),
  ).check(Schema.isMaxLength(TEXT_LIMITS.rounds)),
});
export type Continuation = typeof Continuation.Type;
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
export const jsonBytes = (value: unknown) => Buffer.byteLength(encodeJson(value), "utf8");
export function checkBytes(value: unknown, limit: number) {
  if (jsonBytes(value) > limit) throw new DeusTextError({ code: "bounds" });
}
