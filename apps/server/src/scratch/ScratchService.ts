import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type {
  ChatAttachment,
  ChatAttachmentId,
  ScratchAttachment,
  ScratchConsumeChunkInput,
  ScratchConsumeChunkResult,
  ScratchCreateImageUploadUrlInput,
  ScratchCreateImageUploadUrlResult,
  ScratchDocumentSnapshot,
  ScratchGetInput,
  ScratchKey,
  ScratchSaveInput,
  ScratchSaveResult,
  ScratchSetCursorInput,
  ScratchSetCursorResult,
  ScratchStreamEvent,
  ScratchSubscribeInput,
  ScratchSummariesStreamEvent,
  ScratchSummary,
} from "@t3tools/contracts";
import {
  ScratchRevisionConflictError,
  ScratchStorageError,
  ScratchValidationError,
} from "@t3tools/contracts";
import { extractScratchImageIds } from "@t3tools/shared/scratchDocument";

import { createScratchAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import { issueScratchImageUploadUrl } from "../assets/AttachmentUpload.ts";
import * as ServerConfig from "../config.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

/** Images stay reclaimable for a day after their last markdown reference disappears, covering undo and queued outbox delivery. */
const SCRATCH_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const SCRATCH_CONSUMPTION_ID_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SCRATCH_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const EMPTY_DOCUMENT_UPDATED_AT = DateTime.formatIso(DateTime.toUtc(DateTime.makeUnsafe(0)));

interface ScratchDocumentRow {
  readonly scratch_key: string;
  readonly markdown: string;
  readonly revision: number;
  readonly last_cursor_offset: number;
  readonly updated_at: string;
}

interface ScratchAttachmentRow {
  readonly attachment_id: string;
  readonly scratch_key: string;
  readonly name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly created_at: string;
  readonly unreferenced_at: string | null;
}

type SaveOutcome =
  | { readonly ok: true; readonly snapshot: ScratchDocumentSnapshot }
  | { readonly ok: false; readonly current: ScratchDocumentSnapshot };

function nowIso(nowMs: number): string {
  return DateTime.formatIso(DateTime.toUtc(DateTime.makeUnsafe(nowMs)));
}

function attachmentFromRow(row: ScratchAttachmentRow): ScratchAttachment {
  return {
    attachmentId: row.attachment_id as ChatAttachmentId,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
  };
}

const storageError = (cause: unknown) =>
  new ScratchStorageError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

export interface ScratchShape {
  readonly get: (
    input: ScratchGetInput,
  ) => Effect.Effect<ScratchDocumentSnapshot, ScratchStorageError>;
  readonly summaries: () => Effect.Effect<ReadonlyArray<ScratchSummary>, ScratchStorageError>;
  readonly save: (
    input: ScratchSaveInput,
  ) => Effect.Effect<
    ScratchSaveResult,
    ScratchRevisionConflictError | ScratchStorageError | ScratchValidationError
  >;
  readonly setCursor: (
    input: ScratchSetCursorInput,
  ) => Effect.Effect<ScratchSetCursorResult, ScratchStorageError | ScratchValidationError>;
  readonly consumeChunk: (
    input: ScratchConsumeChunkInput,
  ) => Effect.Effect<
    ScratchConsumeChunkResult,
    ScratchRevisionConflictError | ScratchStorageError | ScratchValidationError
  >;
  readonly createImageUploadUrl: (
    input: ScratchCreateImageUploadUrlInput,
  ) => Effect.Effect<
    ScratchCreateImageUploadUrlResult,
    ScratchStorageError | ScratchValidationError
  >;
  readonly subscribe: (
    input: ScratchSubscribeInput,
  ) => Stream.Stream<ScratchStreamEvent, ScratchStorageError>;
  readonly subscribeSummaries: () => Stream.Stream<
    ScratchSummariesStreamEvent,
    ScratchStorageError
  >;
  readonly sweepExpiredAttachments: (nowMs?: number) => Effect.Effect<number, ScratchStorageError>;
}

export class Scratch extends Context.Service<Scratch, ScratchShape>()(
  "t3/scratch/ScratchService/Scratch",
) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const assetSigner = yield* AssetSigner.AssetSigner;
  const eventPubSub = yield* PubSub.unbounded<ScratchStreamEvent>();
  const summariesPubSub = yield* PubSub.unbounded<ScratchSummariesStreamEvent>();
  const mutex = yield* Semaphore.make(1);
  const lastSweepMs = yield* Ref.make(0);

  const attachmentColumns = sql`attachment_id, scratch_key, name, mime_type, size_bytes, width, height, created_at, unreferenced_at`;

  const loadReferencedAttachments = Effect.fnUntraced(function* (
    scratchKey: ScratchKey,
    markdown: string,
  ) {
    const referencedIds = extractScratchImageIds(markdown);
    if (referencedIds.length === 0) return [] as ReadonlyArray<ScratchAttachmentRow>;
    return yield* sql<ScratchAttachmentRow>`
      SELECT ${attachmentColumns}
      FROM scratch_attachments
      WHERE scratch_key = ${scratchKey} AND attachment_id IN ${sql.in(referencedIds)}
      ORDER BY created_at ASC, attachment_id ASC
    `;
  });

  const loadDocument = Effect.fnUntraced(function* (scratchKey: ScratchKey) {
    const rows = yield* sql<ScratchDocumentRow>`
      SELECT scratch_key, markdown, revision, last_cursor_offset, updated_at
      FROM scratch_documents
      WHERE scratch_key = ${scratchKey}
    `;
    const row = rows[0];
    const markdown = row?.markdown ?? "";
    const attachments = (yield* loadReferencedAttachments(scratchKey, markdown)).map(
      attachmentFromRow,
    );
    return {
      scratchKey,
      markdown,
      revision: row?.revision ?? 0,
      lastCursorOffset: row?.last_cursor_offset ?? 0,
      updatedAt: row?.updated_at ?? EMPTY_DOCUMENT_UPDATED_AT,
      attachments,
    } satisfies ScratchDocumentSnapshot;
  });

  const loadSummaries = Effect.fnUntraced(function* () {
    const rows = yield* sql<{
      readonly scratch_key: string;
      readonly revision: number;
      readonly updated_at: string;
      readonly has_content: number;
    }>`
      SELECT scratch_key, revision, updated_at, has_content
      FROM scratch_documents
      ORDER BY updated_at DESC
    `;
    return rows.map((row): ScratchSummary => ({
      scratchKey: row.scratch_key as ScratchKey,
      revision: row.revision,
      updatedAt: row.updated_at,
      hasContent: row.has_content !== 0,
    }));
  });

  /** Markdown is the only record of which images a scratch still uses, so it drives collection. */
  const reconcileAttachments = Effect.fnUntraced(function* (input: {
    readonly scratchKey: ScratchKey;
    readonly markdown: string;
    readonly now: string;
  }) {
    const referencedIds = extractScratchImageIds(input.markdown);
    if (referencedIds.length > 0) {
      yield* sql`
        UPDATE scratch_attachments
        SET unreferenced_at = NULL
        WHERE scratch_key = ${input.scratchKey}
          AND attachment_id IN ${sql.in(referencedIds)}
          AND unreferenced_at IS NOT NULL
      `;
      yield* sql`
        UPDATE scratch_attachments
        SET unreferenced_at = ${input.now}
        WHERE scratch_key = ${input.scratchKey}
          AND unreferenced_at IS NULL
          AND attachment_id NOT IN ${sql.in(referencedIds)}
      `;
      return;
    }
    yield* sql`
      UPDATE scratch_attachments
      SET unreferenced_at = ${input.now}
      WHERE scratch_key = ${input.scratchKey} AND unreferenced_at IS NULL
    `;
  });

  const upsertDocument = Effect.fnUntraced(function* (input: {
    readonly scratchKey: ScratchKey;
    readonly markdown: string;
    readonly revision: number;
    readonly cursorOffset: number;
    readonly now: string;
  }) {
    const hasContent = input.markdown.trim().length > 0 ? 1 : 0;
    yield* sql`
      INSERT INTO scratch_documents (scratch_key, markdown, has_content, revision, last_cursor_offset, updated_at)
      VALUES (${input.scratchKey}, ${input.markdown}, ${hasContent}, ${input.revision}, ${input.cursorOffset}, ${input.now})
      ON CONFLICT (scratch_key) DO UPDATE SET
        markdown = excluded.markdown,
        has_content = excluded.has_content,
        revision = excluded.revision,
        last_cursor_offset = excluded.last_cursor_offset,
        updated_at = excluded.updated_at
    `;
  });

  const deleteAttachmentFile = Effect.fnUntraced(function* (row: ScratchAttachmentRow) {
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: {
        id: row.attachment_id as ChatAttachmentId,
        type: "image",
        name: row.name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
      } satisfies ChatAttachment,
    });
    if (path !== null) {
      yield* fileSystem.remove(path).pipe(Effect.ignore);
      yield* fileSystem.remove(`${path}.txt`).pipe(Effect.ignore);
    }
  });

  const sweep = Effect.fnUntraced(function* (nowMs: number) {
    const cutoff = nowIso(nowMs - SCRATCH_ATTACHMENT_RETENTION_MS);
    const consumptionCutoff = nowIso(nowMs - SCRATCH_CONSUMPTION_ID_RETENTION_MS);
    const expired = yield* mutex.withPermits(1)(
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<ScratchAttachmentRow>`
            SELECT ${attachmentColumns}
            FROM scratch_attachments
            WHERE unreferenced_at IS NOT NULL AND unreferenced_at <= ${cutoff}
          `;
          if (rows.length > 0) {
            yield* sql`
              DELETE FROM scratch_attachments
              WHERE unreferenced_at IS NOT NULL AND unreferenced_at <= ${cutoff}
            `;
          }
          yield* sql`
            DELETE FROM scratch_consumptions
            WHERE created_at <= ${consumptionCutoff}
          `;
          return rows;
        }),
      ),
    );
    for (const row of expired) {
      yield* deleteAttachmentFile(row);
    }
    return expired.length;
  });

  const publishSnapshot = Effect.fnUntraced(function* (
    snapshot: ScratchDocumentSnapshot,
    originClientId: string | null,
  ) {
    yield* PubSub.publish(eventPubSub, { ...snapshot, originClientId });
    yield* PubSub.publish(summariesPubSub, { summaries: yield* loadSummaries() });
  });

  const get = Effect.fn("Scratch.get")(function* (input: ScratchGetInput) {
    return yield* loadDocument(input.scratchKey).pipe(Effect.mapError(storageError));
  });

  const summaries = Effect.fn("Scratch.summaries")(function* () {
    return yield* loadSummaries().pipe(Effect.mapError(storageError));
  });

  const maybeSweep = Effect.fnUntraced(function* (nowMs: number) {
    const lastSweep = yield* Ref.get(lastSweepMs);
    if (nowMs - lastSweep >= SCRATCH_SWEEP_INTERVAL_MS) {
      yield* Ref.set(lastSweepMs, nowMs);
      yield* sweep(nowMs).pipe(Effect.ignore);
    }
  });

  const writeDocument = Effect.fnUntraced(function* (input: {
    readonly scratchKey: ScratchKey;
    readonly markdown: string;
    readonly expectedRevision: number;
    readonly cursorOffset: number | null;
    readonly now: string;
  }) {
    const current = yield* loadDocument(input.scratchKey);
    if (current.revision !== input.expectedRevision) {
      return { ok: false, current } satisfies SaveOutcome;
    }
    const revision = current.revision + 1;
    const cursorOffset = Math.min(
      input.cursorOffset ?? current.lastCursorOffset,
      input.markdown.length,
    );
    yield* upsertDocument({
      scratchKey: input.scratchKey,
      markdown: input.markdown,
      revision,
      cursorOffset,
      now: input.now,
    });
    yield* reconcileAttachments({
      scratchKey: input.scratchKey,
      markdown: input.markdown,
      now: input.now,
    });
    const attachments = (yield* loadReferencedAttachments(input.scratchKey, input.markdown)).map(
      attachmentFromRow,
    );
    return {
      ok: true,
      snapshot: {
        scratchKey: input.scratchKey,
        markdown: input.markdown,
        revision,
        lastCursorOffset: cursorOffset,
        updatedAt: input.now,
        attachments,
      },
    } satisfies SaveOutcome;
  });

  const save = Effect.fn("Scratch.save")(function* (input: ScratchSaveInput) {
    const nowMs = yield* Clock.currentTimeMillis;
    const outcome = yield* mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const result = yield* sql.withTransaction(
            writeDocument({
              scratchKey: input.scratchKey,
              markdown: input.markdown,
              expectedRevision: input.expectedRevision,
              cursorOffset: input.cursorOffset ?? null,
              now: nowIso(nowMs),
            }),
          );
          if (result.ok) {
            yield* publishSnapshot(result.snapshot, input.clientId);
          }
          return result;
        }),
      )
      .pipe(Effect.mapError(storageError));
    if (!outcome.ok) {
      return yield* new ScratchRevisionConflictError({
        scratchKey: input.scratchKey,
        expectedRevision: input.expectedRevision,
        current: outcome.current,
      });
    }
    yield* maybeSweep(nowMs);
    return {
      scratchKey: outcome.snapshot.scratchKey,
      revision: outcome.snapshot.revision,
      updatedAt: outcome.snapshot.updatedAt,
      attachments: outcome.snapshot.attachments,
    } satisfies ScratchSaveResult;
  });

  const setCursor = Effect.fn("Scratch.setCursor")(function* (input: ScratchSetCursorInput) {
    return yield* mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadDocument(input.scratchKey);
          const nextCursorOffset = Math.min(input.cursorOffset, current.markdown.length);
          if (current.revision === 0 && current.markdown.length === 0) {
            return {
              scratchKey: input.scratchKey,
              lastCursorOffset: 0,
            } satisfies ScratchSetCursorResult;
          }
          if (current.lastCursorOffset === nextCursorOffset) {
            return {
              scratchKey: input.scratchKey,
              lastCursorOffset: nextCursorOffset,
            } satisfies ScratchSetCursorResult;
          }
          yield* sql`
            UPDATE scratch_documents
            SET last_cursor_offset = ${nextCursorOffset}
            WHERE scratch_key = ${input.scratchKey}
          `;
          yield* PubSub.publish(eventPubSub, {
            ...current,
            lastCursorOffset: nextCursorOffset,
            originClientId: input.clientId,
          });
          return {
            scratchKey: input.scratchKey,
            lastCursorOffset: nextCursorOffset,
          } satisfies ScratchSetCursorResult;
        }),
      )
      .pipe(Effect.mapError(storageError));
  });

  const consumeChunk = Effect.fn("Scratch.consumeChunk")(function* (
    input: ScratchConsumeChunkInput,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = nowIso(nowMs);
    const outcome = yield* mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const result = yield* sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* loadDocument(input.scratchKey);
              if (input.consumptionId !== undefined) {
                const existing = yield* sql<{ readonly applied_revision: number }>`
                  SELECT applied_revision
                  FROM scratch_consumptions
                  WHERE consumption_id = ${input.consumptionId}
                    AND scratch_key = ${input.scratchKey}
                `;
                if (existing.length > 0) {
                  return { ok: true, idempotent: true, snapshot: current } as const;
                }
              }
              if (current.revision !== input.expectedRevision) {
                return { ok: false, current } as const;
              }
              const revision = current.revision + 1;
              const cursorOffset = Math.min(
                input.nextCursorOffset ?? current.lastCursorOffset,
                input.nextMarkdown.length,
              );
              const stillReferenced = new Set(extractScratchImageIds(input.nextMarkdown));
              for (const attachmentId of input.consumedAttachmentIds) {
                if (stillReferenced.has(attachmentId)) continue;
                yield* sql`
                  UPDATE scratch_attachments
                  SET unreferenced_at = ${now}
                  WHERE attachment_id = ${attachmentId} AND scratch_key = ${input.scratchKey}
                `;
              }
              yield* upsertDocument({
                scratchKey: input.scratchKey,
                markdown: input.nextMarkdown,
                revision,
                cursorOffset,
                now,
              });
              if (input.consumptionId !== undefined) {
                yield* sql`
                  INSERT OR IGNORE INTO scratch_consumptions (
                    consumption_id, scratch_key, applied_revision, created_at
                  )
                  VALUES (${input.consumptionId}, ${input.scratchKey}, ${revision}, ${now})
                `;
              }
              yield* reconcileAttachments({
                scratchKey: input.scratchKey,
                markdown: input.nextMarkdown,
                now,
              });
              const attachments = (yield* loadReferencedAttachments(
                input.scratchKey,
                input.nextMarkdown,
              )).map(attachmentFromRow);
              return {
                ok: true,
                idempotent: false,
                snapshot: {
                  scratchKey: input.scratchKey,
                  markdown: input.nextMarkdown,
                  revision,
                  lastCursorOffset: cursorOffset,
                  updatedAt: now,
                  attachments,
                },
              } as const;
            }),
          );
          if (result.ok && !result.idempotent) {
            yield* publishSnapshot(result.snapshot, input.clientId);
          }
          return result;
        }),
      )
      .pipe(Effect.mapError(storageError));
    if (!outcome.ok) {
      return yield* new ScratchRevisionConflictError({
        scratchKey: input.scratchKey,
        expectedRevision: input.expectedRevision,
        current: outcome.current,
      });
    }
    yield* maybeSweep(nowMs);
    return {
      scratchKey: outcome.snapshot.scratchKey,
      markdown: outcome.snapshot.markdown,
      revision: outcome.snapshot.revision,
      lastCursorOffset: outcome.snapshot.lastCursorOffset,
      updatedAt: outcome.snapshot.updatedAt,
      attachments: outcome.snapshot.attachments,
    } satisfies ScratchConsumeChunkResult;
  });

  const createImageUploadUrl = Effect.fn("Scratch.createImageUploadUrl")(function* (
    input: ScratchCreateImageUploadUrlInput,
  ) {
    const attachmentId = createScratchAttachmentId();
    const issued = yield* issueScratchImageUploadUrl({
      attachmentId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    }).pipe(
      Effect.provideService(AssetSigner.AssetSigner, assetSigner),
      Effect.catchTags({
        AttachmentUploadSigningKeyError: (cause) => Effect.fail(storageError(cause)),
      }),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT INTO scratch_attachments (
        attachment_id, scratch_key, name, mime_type, size_bytes, width, height, created_at, unreferenced_at
      )
      VALUES (
        ${attachmentId},
        ${input.scratchKey},
        ${input.name},
        ${input.mimeType.toLowerCase()},
        ${input.sizeBytes},
        ${input.width ?? null},
        ${input.height ?? null},
        ${nowIso(nowMs)},
        ${nowIso(nowMs)}
      )
    `.pipe(Effect.mapError(storageError));

    // Uploads are the traffic that creates garbage, so the sweep rides along instead of owning a timer.
    yield* maybeSweep(nowMs);

    return {
      attachmentId,
      relativeUrl: issued.relativeUrl,
      expiresAt: issued.expiresAt,
    } satisfies ScratchCreateImageUploadUrlResult;
  });

  const sweepExpiredAttachments = Effect.fn("Scratch.sweepExpiredAttachments")(function* (
    nowMs?: number,
  ) {
    const now = nowMs ?? (yield* Clock.currentTimeMillis);
    return yield* sweep(now).pipe(Effect.mapError(storageError));
  });

  const subscribe = (input: ScratchSubscribeInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { latest, changes } = yield* subscribeBeforeSnapshot(
          eventPubSub,
          loadDocument(input.scratchKey).pipe(
            Effect.map((document): ScratchStreamEvent => ({
              ...document,
              originClientId: null,
            })),
            Effect.mapError(storageError),
          ),
          mutex,
        );
        return Stream.concat(
          Stream.make(latest),
          changes.pipe(Stream.filter((event) => event.scratchKey === input.scratchKey)),
        );
      }),
    );

  const subscribeSummaries = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { latest, changes } = yield* subscribeBeforeSnapshot(
          summariesPubSub,
          loadSummaries().pipe(
            Effect.map((items) => ({ summaries: items })),
            Effect.mapError(storageError),
          ),
          mutex,
        );
        return Stream.concat(Stream.make(latest), changes);
      }),
    );

  return Scratch.of({
    get,
    summaries,
    save,
    setCursor,
    consumeChunk,
    createImageUploadUrl,
    subscribe,
    subscribeSummaries,
    sweepExpiredAttachments,
  });
});

export const layer: Layer.Layer<
  Scratch,
  never,
  SqlClient.SqlClient | ServerConfig.ServerConfig | FileSystem.FileSystem | AssetSigner.AssetSigner
> = Layer.effect(Scratch, make);
