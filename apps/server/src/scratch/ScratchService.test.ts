import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ChatAttachmentId,
  type ScratchKey,
  ScratchRevisionConflictError,
  ScratchValidationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { formatScratchImageMarkdown } from "@t3tools/shared/scratchDocument";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScratchService from "./ScratchService.ts";

const layerTest = ScratchService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    AssetSigner.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const repoKey = "repo:github.com/acme/widgets" as ScratchKey;
const consumeNowMs = Date.parse("2026-06-01T00:00:00.000Z");
const otherKey = "no-project:test" as ScratchKey;
const shotId = "scratch-00000000-0000-4000-8000-000000000001";
const unreferencedShotId = "scratch-00000000-0000-4000-8000-000000000002";
const otherShotId = "scratch-00000000-0000-4000-8000-000000000003";

const insertScratchImage = (input: {
  readonly attachmentId: string;
  readonly scratchKey: ScratchKey;
  readonly unreferencedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO scratch_attachments (
        attachment_id, scratch_key, name, mime_type, size_bytes, width, height, created_at, unreferenced_at
      )
      VALUES (
        ${input.attachmentId},
        ${input.scratchKey},
        'shot.png',
        'image/png',
        8,
        2,
        2,
        '2026-01-01T00:00:00.000Z',
        ${input.unreferencedAt}
      )
    `;
  });

const readUnreferencedAt = (attachmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly unreferenced_at: string | null }>`
      SELECT unreferenced_at FROM scratch_attachments WHERE attachment_id = ${attachmentId}
    `;
    return rows[0]?.unreferenced_at ?? null;
  });

const hasScratchImage = (attachmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly attachment_id: string }>`
      SELECT attachment_id FROM scratch_attachments WHERE attachment_id = ${attachmentId}
    `;
    return rows.length === 1;
  });

it.effect("returns an empty document for a key nothing was saved under", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    const snapshot = yield* scratch.get({ scratchKey: repoKey });
    assert.strictEqual(snapshot.scratchKey, repoKey);
    assert.strictEqual(snapshot.markdown, "");
    assert.strictEqual(snapshot.revision, 0);
    assert.deepStrictEqual(snapshot.attachments, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("saves markdown, bumps the revision, and rejects a stale write", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    const first = yield* scratch.save({
      scratchKey: repoKey,
      markdown: "# Notes",
      expectedRevision: 0,
      clientId: "editor-a",
      cursorOffset: 7,
    });
    assert.strictEqual(first.revision, 1);

    const stored = yield* scratch.get({ scratchKey: repoKey });
    assert.strictEqual(stored.markdown, "# Notes");
    assert.strictEqual(stored.lastCursorOffset, 7);

    const conflict = yield* scratch
      .save({
        scratchKey: repoKey,
        markdown: "stale",
        expectedRevision: 0,
        clientId: "editor-b",
      })
      .pipe(Effect.flip);
    assert.instanceOf(conflict, ScratchRevisionConflictError);
    assert.strictEqual(conflict.current.markdown, "# Notes");
    assert.strictEqual(conflict.current.revision, 1);

    const second = yield* scratch.save({
      scratchKey: repoKey,
      markdown: "# Notes\nmore",
      expectedRevision: 1,
      clientId: "editor-a",
    });
    assert.strictEqual(second.revision, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists a summary per saved document and streams live snapshots", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    yield* scratch.save({
      scratchKey: repoKey,
      markdown: "# Notes",
      expectedRevision: 0,
      clientId: "editor-a",
    });

    // The save runs from the first pull, so the second pull must see its event.
    const seen = Array.from(
      yield* scratch.subscribe({ scratchKey: repoKey }).pipe(
        Stream.tap((event) =>
          event.revision === 1
            ? scratch.save({
                scratchKey: repoKey,
                markdown: "# Notes 2",
                expectedRevision: 1,
                clientId: "editor-b",
              })
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
      ),
    );
    assert.deepStrictEqual(
      seen.map((event) => [event.revision, event.markdown, event.originClientId]),
      [
        [1, "# Notes", null],
        [2, "# Notes 2", "editor-b"],
      ],
    );

    const summaries = yield* scratch.summaries();
    assert.deepStrictEqual(
      summaries.map((summary) => [summary.scratchKey, summary.revision, summary.hasContent]),
      [[repoKey, 2, true]],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("streams summary updates and treats a whitespace-only document as empty", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    const seen = Array.from(
      yield* scratch.subscribeSummaries().pipe(
        Stream.tap((event) => {
          if (event.summaries.length === 0) {
            return scratch.save({
              scratchKey: repoKey,
              markdown: "   ",
              expectedRevision: 0,
              clientId: "editor-a",
            });
          }
          return event.summaries[0]?.hasContent === false
            ? scratch.save({
                scratchKey: repoKey,
                markdown: "# Notes",
                expectedRevision: 1,
                clientId: "editor-a",
              })
            : Effect.void;
        }),
        Stream.take(3),
        Stream.runCollect,
      ),
    );
    assert.deepStrictEqual(
      seen.map((event) => event.summaries.map((summary) => summary.hasContent)),
      [[], [false], [true]],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps an uploaded image out of the document until markdown references it", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    const issued = yield* scratch.createImageUploadUrl({
      scratchKey: repoKey,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 8,
      width: 2,
      height: 2,
    });
    assert.match(issued.attachmentId, /^scratch-[0-9a-f-]{36}$/);
    assert.match(issued.relativeUrl, /^\/api\/attachments\/upload\//);

    assert.deepStrictEqual((yield* scratch.get({ scratchKey: repoKey })).attachments, []);
    assert.strictEqual(yield* hasScratchImage(issued.attachmentId), true);

    const saved = yield* scratch.save({
      scratchKey: repoKey,
      markdown: formatScratchImageMarkdown(issued.attachmentId, "shot"),
      expectedRevision: 0,
      clientId: "editor-a",
    });
    assert.deepStrictEqual(
      saved.attachments.map((attachment) => attachment.attachmentId),
      [issued.attachmentId],
    );
    assert.strictEqual(yield* readUnreferencedAt(issued.attachmentId), null);

    const cleared = yield* scratch.save({
      scratchKey: repoKey,
      markdown: "no image",
      expectedRevision: 1,
      clientId: "editor-a",
    });
    assert.deepStrictEqual(cleared.attachments, []);
    assert.strictEqual((yield* scratch.get({ scratchKey: repoKey })).attachments.length, 0);
    assert.notStrictEqual(yield* readUnreferencedAt(issued.attachmentId), null);

    // Undo restores the reference, so a collection window cannot drop it.
    const restored = yield* scratch.save({
      scratchKey: repoKey,
      markdown: formatScratchImageMarkdown(issued.attachmentId, "shot"),
      expectedRevision: 2,
      clientId: "editor-a",
    });
    assert.deepStrictEqual(
      restored.attachments.map((attachment) => attachment.attachmentId),
      [issued.attachmentId],
    );
    assert.strictEqual(yield* readUnreferencedAt(issued.attachmentId), null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("issues an image upload url and refuses images a provider cannot receive", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    const rejected = yield* scratch
      .createImageUploadUrl({
        scratchKey: repoKey,
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 8,
      })
      .pipe(Effect.flip);
    assert.instanceOf(rejected, ScratchValidationError);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("consumes attachments only on chunked sends and then forgets them", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    yield* TestClock.setTime(consumeNowMs);
    yield* insertScratchImage({ attachmentId: shotId, scratchKey: repoKey, unreferencedAt: null });
    const saved = yield* scratch.save({
      scratchKey: repoKey,
      markdown: formatScratchImageMarkdown(shotId, "shot"),
      expectedRevision: 0,
      clientId: "editor-a",
    });
    assert.deepStrictEqual(
      saved.attachments.map((attachment) => attachment.attachmentId),
      [shotId],
    );

    const conflict = yield* scratch
      .consumeChunk({
        scratchKey: repoKey,
        expectedRevision: 0,
        clientId: "editor-a",
        nextMarkdown: "",
        consumedAttachmentIds: [shotId as ChatAttachmentId],
      })
      .pipe(Effect.flip);
    assert.instanceOf(conflict, ScratchRevisionConflictError);
    assert.strictEqual((yield* scratch.get({ scratchKey: repoKey })).attachments.length, 1);

    const consumed = yield* scratch.consumeChunk({
      scratchKey: repoKey,
      expectedRevision: 1,
      clientId: "editor-a",
      nextMarkdown: "",
      consumedAttachmentIds: [shotId as ChatAttachmentId],
    });
    assert.strictEqual(consumed.revision, 2);
    assert.deepStrictEqual(consumed.attachments, []);
    assert.strictEqual((yield* scratch.get({ scratchKey: repoKey })).attachments.length, 0);

    // The message already carries the image, so only the undo window still needs it.
    // Consumed attachments are marked unreferenced immediately and reclaimed once the 24h retention window elapses.
    assert.strictEqual(yield* readUnreferencedAt(shotId), "2026-06-01T00:00:00.000Z");
    assert.strictEqual(yield* scratch.sweepExpiredAttachments(consumeNowMs + 60 * 60 * 1000), 0);
    assert.strictEqual(
      yield* scratch.sweepExpiredAttachments(consumeNowMs + 24 * 60 * 60 * 1000),
      1,
    );
    assert.strictEqual(yield* hasScratchImage(shotId), false);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("releases images unreferenced for a full day, whichever scratch wrote them", () =>
  Effect.gen(function* () {
    const scratch = yield* ScratchService.Scratch;
    const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
    yield* insertScratchImage({ attachmentId: shotId, scratchKey: repoKey, unreferencedAt: null });
    yield* insertScratchImage({
      attachmentId: unreferencedShotId,
      scratchKey: repoKey,
      unreferencedAt: "2026-01-01T00:00:00.000Z",
    });
    yield* insertScratchImage({
      attachmentId: otherShotId,
      scratchKey: otherKey,
      unreferencedAt: "2026-05-31T12:00:00.000Z",
    });

    assert.strictEqual(yield* scratch.sweepExpiredAttachments(nowMs), 1);
    assert.strictEqual(yield* hasScratchImage(unreferencedShotId), false);
    assert.strictEqual(yield* hasScratchImage(shotId), true);
    assert.strictEqual(yield* hasScratchImage(otherShotId), true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "syncs global cursor offset without bumping revision and makes consumeChunk idempotent",
  () =>
    Effect.gen(function* () {
      const scratch = yield* ScratchService.Scratch;
      const sql = yield* SqlClient.SqlClient;

      // setCursor on an empty rev-0 document is a no-op that does not create a row.
      const emptyCursor = yield* scratch.setCursor({
        scratchKey: repoKey,
        cursorOffset: 9,
        clientId: "device-a",
      });
      assert.strictEqual(emptyCursor.lastCursorOffset, 0);

      const saved = yield* scratch.save({
        scratchKey: repoKey,
        markdown: "First block\n\nSecond block",
        expectedRevision: 0,
        clientId: "device-a",
        cursorOffset: 5,
      });
      assert.strictEqual(saved.revision, 1);

      // Live subscribers observe setCursor broadcasts with originClientId and unchanged revision.
      const cursorStream = scratch.subscribe({ scratchKey: repoKey });
      const [initialEvent, cursorEvent] = yield* Stream.runCollect(
        Stream.take(cursorStream, 2),
      ).pipe(
        Effect.forkChild,
        Effect.flatMap((fiber) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow;
            const updated = yield* scratch.setCursor({
              scratchKey: repoKey,
              cursorOffset: 18,
              clientId: "device-a",
            });
            assert.strictEqual(updated.lastCursorOffset, 18);
            return yield* Fiber.join(fiber);
          }),
        ),
      );
      assert.strictEqual(initialEvent?.revision, 1);
      assert.strictEqual(cursorEvent?.revision, 1);
      assert.strictEqual(cursorEvent?.lastCursorOffset, 18);
      assert.strictEqual(cursorEvent?.originClientId, "device-a");

      const firstConsume = yield* scratch.consumeChunk({
        scratchKey: repoKey,
        expectedRevision: 1,
        clientId: "device-a",
        nextMarkdown: "First block",
        nextCursorOffset: 11,
        consumedAttachmentIds: [],
        consumptionId: "msg-idempotent-1",
      });
      assert.strictEqual(firstConsume.revision, 2);
      assert.strictEqual(firstConsume.markdown, "First block");
      assert.strictEqual(firstConsume.lastCursorOffset, 11);

      // A peer edits the remaining document before the original client replays the same consumptionId.
      yield* scratch.save({
        scratchKey: repoKey,
        markdown: "First block\n\nPeer follow-up",
        expectedRevision: 2,
        clientId: "device-b",
        cursorOffset: 27,
      });

      // Replaying the same consumptionId returns the current authoritative server state without rolling back peer edits.
      const replay = yield* scratch.consumeChunk({
        scratchKey: repoKey,
        expectedRevision: 1,
        clientId: "device-a",
        nextMarkdown: "First block",
        nextCursorOffset: 11,
        consumedAttachmentIds: [],
        consumptionId: "msg-idempotent-1",
      });
      assert.strictEqual(replay.revision, 3);
      assert.strictEqual(replay.markdown, "First block\n\nPeer follow-up");
      assert.strictEqual(replay.lastCursorOffset, 27);

      // Reusing the same consumptionId on a different project is scoped per scratch_key.
      yield* scratch.save({
        scratchKey: otherKey,
        markdown: "Other A\n\nOther B",
        expectedRevision: 0,
        clientId: "device-a",
      });
      const otherConsume = yield* scratch.consumeChunk({
        scratchKey: otherKey,
        expectedRevision: 1,
        clientId: "device-a",
        nextMarkdown: "Other A",
        nextCursorOffset: 7,
        consumedAttachmentIds: [],
        consumptionId: "msg-idempotent-1",
      });
      assert.strictEqual(otherConsume.revision, 2);
      assert.strictEqual(otherConsume.markdown, "Other A");

      // Sweeping past the 14-day consumption retention window prunes old consumption records.
      const futureMs = 15 * 24 * 60 * 60 * 1000;
      yield* scratch.sweepExpiredAttachments(futureMs);
      const remainingConsumptions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scratch_consumptions
      `;
      assert.strictEqual(remainingConsumptions[0]?.count, 0);
    }).pipe(Effect.provide(layerTest)),
);
