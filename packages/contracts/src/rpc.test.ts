import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { DeusRpcGroup, WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { DeusSettings } from "./settings.ts";
import {
  DEUS_MAX_PCM_BYTES,
  DEUS_MAX_TRANSIENT_TEXT_LENGTH,
  DEUS_PROTOCOL_VERSION,
  DEUS_UNAVAILABLE,
  DeusConfiguration,
  DeusCredentialInput,
  DeusDurableChange,
  DeusError,
  DeusMediaOutput,
  DeusPcmInput,
  DeusSnapshot,
  resolveDeusCapabilities,
} from "./deus.ts";

const decodeDeusPcmInput = Schema.decodeUnknownExit(DeusPcmInput);
const decodeDeusDurableChange = Schema.decodeUnknownExit(DeusDurableChange);
const decodeDeusMediaOutput = Schema.decodeUnknownExit(DeusMediaOutput);
const decodeDeusCredentialInput = Schema.decodeUnknownExit(DeusCredentialInput);
const decodeDeusSettings = Schema.decodeSync(DeusSettings);
const encodeDeusConfiguration = Schema.encodeUnknownSync(Schema.toCodecJson(DeusConfiguration));
const encodeDeusSnapshot = Schema.encodeUnknownSync(Schema.toCodecJson(DeusSnapshot));
const deusErrorCodec = Schema.toCodecJson(DeusError);
const encodeDeusError = Schema.encodeSync(deusErrorCodec);
const decodeDeusError = Schema.decodeSync(deusErrorCodec);

describe("WebSocket RPC contracts", () => {
  it("opens a project-scoped Deus session without a worker thread", () => {
    const open = WsRpcGroup.requests.get(WS_METHODS.deusOpen);
    expect(open).toBeDefined();
    if (open === undefined) throw new Error("deus.open is not registered");
    const decode = Schema.decodeUnknownExit(open.payloadSchema);
    expect(
      Exit.isSuccess(
        decode({ environmentId: "environment", projectId: "project", inputId: "input" }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decode({ projectId: "project", inputId: "input" }))).toBe(true);
  });

  it("keeps unavailable capability discovery compatible with legacy servers", () => {
    expect(resolveDeusCapabilities({})).toEqual({
      available: false,
      protocolVersion: DEUS_PROTOCOL_VERSION,
      reason: "unsupported",
    });
    expect(resolveDeusCapabilities({ deus: DEUS_UNAVAILABLE })).toBe(DEUS_UNAVAILABLE);
    expect(
      [...DeusRpcGroup.requests.keys()].every((method) => WsRpcGroup.requests.has(method)),
    ).toBe(true);
  });

  it("bounds transient PCM and partial transcripts independently of durable replay", () => {
    const envelope = {
      environmentId: "environment",
      projectId: "project",
      sessionId: "session",
      attachmentId: "attachment",
      generation: 1,
      responseEpoch: 0,
      sequence: 0,
    };
    const pcm = {
      ...envelope,
      type: "pcm",
      encoding: "pcm16le",
      channels: 1,
      sampleRate: 16_000,
      data: Base64.encode(new Uint8Array(DEUS_MAX_PCM_BYTES)),
    };
    expect(Exit.isSuccess(decodeDeusPcmInput(pcm))).toBe(true);
    for (const patch of [
      { data: Base64.encode(new Uint8Array(DEUS_MAX_PCM_BYTES + 2)) },
      { data: "AA==" },
      { data: "invalid" },
      { sampleRate: 24_000 },
      { channels: 2 },
      { generation: 0 },
      { sequence: -1 },
      { responseEpoch: -1 },
    ])
      expect(Exit.isFailure(decodeDeusPcmInput({ ...pcm, ...patch }))).toBe(true);
    expect(Exit.isFailure(decodeDeusDurableChange(pcm))).toBe(true);
    const partial = { ...envelope, type: "partial-transcript", role: "human", text: "hello" };
    expect(Exit.isSuccess(decodeDeusMediaOutput(partial))).toBe(true);
    expect(
      Exit.isFailure(
        decodeDeusMediaOutput({
          ...partial,
          text: "x".repeat(DEUS_MAX_TRANSIENT_TEXT_LENGTH + 1),
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeDeusDurableChange(partial))).toBe(true);
  });

  it("serializes metadata snapshots and configuration without media or credential values", () => {
    const scope = { environmentId: "environment", projectId: "project" };
    const configuration = encodeDeusConfiguration({
      ...scope,
      settings: decodeDeusSettings({}),
      credentialConfigured: true,
      credential: "must-not-leak",
    });
    expect(configuration).toEqual({
      ...scope,
      settings: {
        enabled: false,
        textModel: null,
        liveModel: null,
        voice: null,
        learningEnabled: false,
        ponderModel: null,
      },
      credentialConfigured: true,
    });
    const snapshot = {
      session: {
        ...scope,
        sessionId: "session",
        conversation: 1,
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
      },
      cursor: 0,
      transcripts: [],
      tasks: [],
      reports: [],
      observations: [],
      memories: [],
      ponderReceipts: [],
    };
    expect(
      encodeDeusSnapshot({
        ...snapshot,
        pcm: "AAAA",
        credential: "must-not-leak",
      }),
    ).toEqual(snapshot);
    expect(Exit.isSuccess(decodeDeusCredentialInput({ ...scope, secretRef: "one-use-ref" }))).toBe(
      true,
    );
    expect(Exit.isSuccess(decodeDeusCredentialInput({ ...scope, secretRef: null }))).toBe(true);
    expect(
      Exit.isFailure(decodeDeusCredentialInput({ ...scope, credential: "must-not-send" })),
    ).toBe(true);
  });

  it.each([
    { _tag: "DeusUnavailableError", reason: "unsupported" },
    { _tag: "DeusPermissionError", requiredScope: "orchestration:operate" },
    { _tag: "DeusLeaseError", reason: "stale-generation" },
    { _tag: "DeusToolError", tool: "launch", retryable: true },
    { _tag: "DeusModelError", reason: "unavailable" },
    { _tag: "DeusTransportError", reason: "invalid-pcm" },
    { _tag: "DeusStateError", reason: "scope-mismatch" },
  ])("round-trips typed Deus errors: $_tag", (error) => {
    const wire = { ...error, message: "Unavailable for this request." };
    expect(encodeDeusError(decodeDeusError(wire))).toEqual(wire);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
