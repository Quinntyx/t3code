import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scratch_documents (
      scratch_key TEXT PRIMARY KEY,
      markdown TEXT NOT NULL DEFAULT '',
      has_content INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      last_cursor_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scratch_attachments (
      attachment_id TEXT PRIMARY KEY,
      scratch_key TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      unreferenced_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scratch_attachments_key
    ON scratch_attachments (scratch_key)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scratch_attachments_gc
    ON scratch_attachments (unreferenced_at)
    WHERE unreferenced_at IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scratch_consumptions (
      consumption_id TEXT NOT NULL,
      scratch_key TEXT NOT NULL,
      applied_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (consumption_id, scratch_key)
    )
  `;
});
