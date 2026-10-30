import {
  DEUS_MAX_PCM_BYTES,
  DeusPcmInput,
  DeusMediaOutput,
  DeusTransportError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

export const DEUS_MEDIA_WIRE_BYTES = 48_000;
const invalid = () =>
  new DeusTransportError({
    reason: "invalid-pcm",
    message:
      "Deus media must be canonical, bounded mono PCM16LE with whole samples and a complete bounded wire envelope.",
  });
export function decodeDeusPcm(data: string): Uint8Array {
  const decoded = Base64.decode(data);
  if (
    Result.isFailure(decoded) ||
    decoded.success.length === 0 ||
    decoded.success.length > DEUS_MAX_PCM_BYTES ||
    decoded.success.length % 2 !== 0 ||
    Base64.encode(decoded.success) !== data
  )
    throw invalid();
  return decoded.success;
}
const decodeInput = Schema.decodeUnknownSync(DeusPcmInput);
const decodeOutput = Schema.decodeUnknownSync(DeusMediaOutput);
const size = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function validate(message: unknown, bytes: number): void {
  if (!isRecord(message)) return;
  let pcm = false;
  try {
    if (message._tag === "Request" && message.tag === WS_METHODS.deusMediaPush) {
      decodeDeusPcm(decodeInput(message.payload).data);
      pcm = true;
    } else if (message._tag === "Chunk" && Array.isArray(message.values)) {
      for (const value of message.values) {
        if (!isRecord(value) || value.type !== "pcm" || !("attachmentId" in value)) continue;
        const output = decodeOutput(value);
        if (output.type === "pcm") decodeDeusPcm(output.data);
        pcm = true;
      }
    }
  } catch {
    throw invalid();
  }
  if (pcm && bytes > DEUS_MEDIA_WIRE_BYTES) throw invalid();
}
export const deusJson: RpcSerialization.RpcSerialization["Service"] = {
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe();
    return {
      encode: (message) => {
        const encoded = parser.encode(message);
        if (encoded !== undefined) validate(message, size(encoded));
        return encoded;
      },
      decode: (data) => {
        const messages = parser.decode(data);
        for (const message of messages) validate(message, size(data));
        return messages;
      },
    };
  },
};
