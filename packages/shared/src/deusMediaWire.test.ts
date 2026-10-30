import { describe, expect, it } from "@effect/vitest";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { deusJson, DEUS_MEDIA_WIRE_BYTES } from "./deusMediaWire.ts";

const envelope = {
  environmentId: "environment",
  projectId: "project",
  sessionId: "session",
  attachmentId: "attachment",
  generation: 1,
  responseEpoch: 0,
  sequence: 1,
};
const pcm = {
  ...envelope,
  type: "pcm",
  encoding: "pcm16le",
  channels: 1,
  sampleRate: 16000,
  data: Base64.encode(new Uint8Array(32000)),
};
const request = (payload: unknown) => ({
  _tag: "Request",
  id: "1",
  tag: "deus.mediaPush",
  payload,
  headers: [],
});

describe("Deus complete JSON wire envelopes", () => {
  it.effect("uses the existing RPC JSON encoding and measures the whole bounded request", () =>
    Effect.gen(function* () {
      const parser = deusJson.makeUnsafe();
      const frame = parser.encode(request(pcm));
      expect(typeof frame).toBe("string");
      expect(parser.decode(frame!)).toEqual([request(pcm)]);
      const bytes = new TextEncoder().encode(frame as string).length;
      expect(bytes).toBeLessThanOrEqual(DEUS_MEDIA_WIRE_BYTES);
      yield* Effect.logInfo(
        `deus-wire fixture: decoded=32000 complete-request=${bytes} limit=${DEUS_MEDIA_WIRE_BYTES}`,
      );
    }),
  );
  it("rejects odd samples, noncanonical base64, wrong direction/rate and oversized complete envelopes", () => {
    const parser = deusJson.makeUnsafe();
    for (const patch of [
      { data: "AAAA" },
      { data: "AAB=" },
      { sampleRate: 24000 },
      { channels: 2 },
      { sequence: -1 },
    ])
      expect(() => parser.encode(request({ ...pcm, ...patch }))).toThrow();
    const padded = { ...request(pcm), headers: [["oversize", "x".repeat(DEUS_MEDIA_WIRE_BYTES)]] };
    expect(() => parser.encode(padded)).toThrow();
    expect(() => parser.decode(JSON.stringify(padded))).toThrow();
  });
  it("preserves official JSON bytes and decoding for unrelated requests, exits and streams", () => {
    const official = RpcSerialization.json.makeUnsafe();
    const parser = deusJson.makeUnsafe();
    for (const message of [
      { _tag: "Ping" },
      { ...request({}), tag: "server.probe" },
      { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: {} } },
      { _tag: "Exit", requestId: "2", exit: { _tag: "Failure", cause: [] } },
      { _tag: "Chunk", requestId: "3", values: [{ type: "snapshot", text: "m".repeat(60000) }] },
    ]) {
      const frame = official.encode(message)!;
      expect(parser.encode(message)).toBe(frame);
      expect(parser.decode(frame)).toEqual(official.decode(frame));
      const bytes = new TextEncoder().encode(frame as string);
      expect(parser.decode(bytes)).toEqual(official.decode(bytes));
    }
  });
  it("checks output PCM and stream batching without imposing media bounds on metadata", () => {
    const parser = deusJson.makeUnsafe();
    const output = { ...pcm, sampleRate: 24000 };
    const chunk = (values: unknown[]) => ({ _tag: "Chunk", requestId: "2", values });
    expect(parser.decode(parser.encode(chunk([output]))!)).toEqual([chunk([output])]);
    expect(() => parser.encode(chunk([pcm]))).toThrow();
    expect(() => parser.encode(chunk([output, output]))).toThrow();
    const metadata = chunk([{ type: "snapshot", text: "m".repeat(60000) }]);
    expect(parser.decode(parser.encode(metadata)!)).toEqual([metadata]);
    expect(
      parser.encode({
        _tag: "Request",
        id: "3",
        tag: "deus.mediaControl",
        payload: { ...envelope, action: "interrupt" },
        headers: [],
      }),
    ).toBeDefined();
  });
});
