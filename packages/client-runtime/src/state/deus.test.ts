import { describe, expect, it } from "vite-plus/test";
import {
  DeusConversation,
  DeusCursor,
  DeusInputId,
  DeusSessionId,
  DeusTranscriptId,
  EnvironmentId,
  ProjectId,
  type DeusSnapshot,
  type DeusTranscript,
} from "@t3tools/contracts";
import {
  createDeusLocalAttachment,
  projectDeusConversation,
  DEUS_TRANSCRIPT_LIMIT,
} from "./deus.ts";

const ref = {
  environmentId: EnvironmentId.make("one"),
  projectId: ProjectId.make("project"),
  sessionId: DeusSessionId.make("session"),
};
const transcript = (id: number): DeusTranscript => ({
  id: DeusTranscriptId.make(`text-${id}`),
  inputId: DeusInputId.make(`input-${id}`),
  conversation: DeusConversation.make(1),
  role: "human",
  text: `Message ${id}`,
  createdAt: "2026-10-30T00:00:00.000Z",
});
const snapshot = (cursor = 0): DeusSnapshot => ({
  session: {
    ...ref,
    conversation: DeusConversation.make(1),
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  },
  cursor: DeusCursor.make(cursor),
  transcripts: [transcript(1)],
  tasks: [],
  reports: [],
  observations: [],
  memories: [],
  ponderReceipts: [],
});

describe("Deus durable conversation projection", () => {
  it("retains canonical identities through overlapping replay and refresh", () => {
    const initial = projectDeusConversation(null, { type: "snapshot", snapshot: snapshot(1) }, ref);
    const event = {
      type: "delta" as const,
      delta: {
        ...ref,
        previousCursor: DeusCursor.make(1),
        cursor: DeusCursor.make(2),
        change: { type: "transcript" as const, transcript: transcript(2) },
      },
    };
    const live = projectDeusConversation(initial, event, ref);
    expect(projectDeusConversation(live, event, ref)).toBe(live);
    expect(projectDeusConversation(live, { type: "snapshot", snapshot: snapshot(1) }, ref)).toBe(
      live,
    );
    const refreshed = projectDeusConversation(
      live,
      {
        type: "snapshot",
        snapshot: { ...snapshot(2), transcripts: [transcript(1), transcript(2)] },
      },
      ref,
    );
    expect(refreshed.transcripts.map((row) => row.id)).toEqual(["text-1", "text-2"]);
  });
  it("rejects cross-environment identity and missing cursors instead of mixing destinations", () => {
    expect(() =>
      projectDeusConversation(
        null,
        { type: "snapshot", snapshot: snapshot() },
        { ...ref, environmentId: EnvironmentId.make("two") },
      ),
    ).toThrow();
    const initial = projectDeusConversation(null, { type: "snapshot", snapshot: snapshot() }, ref);
    expect(() =>
      projectDeusConversation(
        initial,
        {
          type: "delta",
          delta: {
            ...ref,
            previousCursor: DeusCursor.make(1),
            cursor: DeusCursor.make(2),
            change: { type: "transcript", transcript: transcript(2) },
          },
        },
        ref,
      ),
    ).toThrow();
  });
  it("bounds old transcript rows without erasing history on conversation reset", () => {
    const rows = Array.from({ length: DEUS_TRANSCRIPT_LIMIT + 9 }, (_, i) => transcript(i));
    const initial = projectDeusConversation(
      null,
      { type: "snapshot", snapshot: { ...snapshot(), transcripts: rows } },
      ref,
    );
    expect(initial.transcripts).toHaveLength(DEUS_TRANSCRIPT_LIMIT);
    const reset = projectDeusConversation(
      initial,
      {
        type: "delta",
        delta: {
          ...ref,
          previousCursor: DeusCursor.make(0),
          cursor: DeusCursor.make(1),
          change: { type: "conversation-reset", conversation: DeusConversation.make(2) },
        },
      },
      ref,
    );
    expect(reset.transcripts).toEqual(initial.transcripts);
    expect(reset.session.conversation).toBe(2);
  });
});

describe("local Deus attachment ownership", () => {
  it("releases only the selected local attachment once, including concurrent cleanup", async () => {
    const owner = createDeusLocalAttachment();
    let complete!: () => void;
    let releases = 0;
    const stopped = new Promise<void>((resolve) => {
      complete = resolve;
    });
    owner.register(ref, () => {
      releases++;
      return stopped;
    });
    expect(owner.has(ref)).toBe(true);
    await owner.release({ ...ref, environmentId: EnvironmentId.make("elsewhere") });
    expect(releases).toBe(0);
    const first = owner.release(ref);
    const second = owner.release(ref);
    expect(releases).toBe(1);
    complete();
    await Promise.all([first, second]);
    expect(owner.has(ref)).toBe(false);
  });
  it("retains a failed release for an explicit retry", async () => {
    const owner = createDeusLocalAttachment();
    let attempts = 0;
    owner.register(ref, async () => {
      if (++attempts === 1) throw new Error("Local audio did not stop");
    });
    await expect(owner.release(ref)).rejects.toThrow("Local audio did not stop");
    expect(owner.has(ref)).toBe(true);
    await owner.release(ref);
    expect(owner.has(ref)).toBe(false);
  });
});
