import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type GenerateContentParameters,
} from "@google/genai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Configuration from "./DeusConfiguration.ts";
import {
  DeusTextError,
  TEXT_LIMITS,
  TextReply,
  checkBytes,
  encodeJson,
  decodeJson,
  type TextContent,
} from "./textProtocol.ts";

const decodeReply = Schema.decodeUnknownEffect(TextReply);
export interface TextRequest {
  readonly systemInstruction: string;
  readonly contents: ReadonlyArray<TextContent>;
  readonly tools?: ReadonlyArray<FunctionDeclaration>;
}
export class GeminiTextAdapter extends Context.Service<
  GeminiTextAdapter,
  {
    readonly generate: (request: TextRequest) => Effect.Effect<TextReply, DeusTextError>;
  }
>()("t3/deus/GeminiTextAdapter") {}
export const layerWithClient = (client: (key: string) => Pick<GoogleGenAI, "models">) =>
  Layer.effect(
    GeminiTextAdapter,
    Effect.gen(function* () {
      const configuration = yield* Configuration.DeusConfiguration;
      return GeminiTextAdapter.of({
        generate: Effect.fn("GeminiTextAdapter.generate")((request) =>
          configuration.withTextCredential((model, key) =>
            Effect.gen(function* () {
              const parameters: GenerateContentParameters = {
                model,
                contents: request.contents.map((content) => ({
                  role: content.role,
                  parts: [...content.parts],
                })),
                config: {
                  httpOptions: { timeout: 60_000, retryOptions: { attempts: 1 } },
                  systemInstruction: request.systemInstruction,
                  maxOutputTokens: 2048,
                  candidateCount: 1,
                  automaticFunctionCalling: { disable: true },
                  ...(request.tools?.length
                    ? { tools: [{ functionDeclarations: [...request.tools] }] }
                    : {}),
                  toolConfig: {
                    functionCallingConfig: {
                      mode: request.tools?.length
                        ? FunctionCallingConfigMode.AUTO
                        : FunctionCallingConfigMode.NONE,
                    },
                  },
                },
              };
              yield* Effect.try({
                try: () => checkBytes(parameters, TEXT_LIMITS.requestBytes),
                catch: () => new DeusTextError({ code: "bounds" }),
              });
              const response = yield* Effect.tryPromise({
                try: (signal) =>
                  client(key).models.generateContent({
                    ...parameters,
                    config: { ...parameters.config, abortSignal: signal },
                  }),
                catch: () => new DeusTextError({ code: "provider" }),
              });
              const candidate = response.candidates?.[0];
              if (candidate?.finishReason !== "STOP" || !candidate.content?.parts?.length)
                return yield* new DeusTextError({ code: "provider" });
              const reply = yield* Effect.try({
                try: () => {
                  checkBytes(candidate.content, TEXT_LIMITS.responseBytes);
                  const escaped = encodeJson(key).slice(1, -1);
                  return decodeJson(
                    encodeJson({ parts: candidate.content!.parts }).replaceAll(
                      escaped,
                      "[REDACTED]",
                    ),
                  );
                },
                catch: () => new DeusTextError({ code: "bounds" }),
              });
              const decoded = yield* decodeReply(reply, {
                onExcessProperty: "error",
              }).pipe(Effect.mapError(() => new DeusTextError({ code: "provider" })));
              if (
                decoded.parts.some(
                  (part) => part.functionResponse || (!request.tools?.length && part.functionCall),
                ) ||
                decoded.parts.filter((part) => part.functionCall).length > TEXT_LIMITS.calls
              )
                return yield* new DeusTextError({ code: "provider" });
              return decoded;
            }),
          ),
        ),
      });
    }),
  );
export const layer = layerWithClient((apiKey) => new GoogleGenAI({ apiKey }));
