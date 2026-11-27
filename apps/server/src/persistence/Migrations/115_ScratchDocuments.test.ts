import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("115_ScratchDocuments", (it) => {
  it.effect("creates the scratch document and attachment tables with their indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 115 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      assert.includeMembers(
        tables.map((table) => table.name),
        ["scratch_attachments", "scratch_documents"],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
      `;
      assert.includeMembers(
        indexes.map((index) => index.name),
        ["idx_scratch_attachments_gc", "idx_scratch_attachments_key"],
      );

      yield* sql`
        INSERT INTO scratch_documents (scratch_key, markdown, revision, last_cursor_offset, updated_at)
        VALUES ('path:test:/repo', '', 0, 0, '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO scratch_attachments (
          attachment_id,
          scratch_key,
          name,
          mime_type,
          size_bytes,
          width,
          height,
          created_at,
          unreferenced_at
        )
        VALUES (
          'scratch-00000000-0000-4000-8000-000000000000',
          'path:test:/repo',
          'image.png',
          'image/png',
          4,
          1,
          1,
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;
      const [row] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scratch_attachments WHERE unreferenced_at IS NULL
      `;
      assert.equal(row?.count, 1);
    }),
  );
});
