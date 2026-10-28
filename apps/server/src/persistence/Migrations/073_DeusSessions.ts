import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE deus_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    snapshot_json TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (environment_id, project_id)
  )`;
  yield* sql`CREATE TABLE deus_events (
    session_id TEXT NOT NULL REFERENCES deus_sessions(session_id),
    cursor INTEGER NOT NULL CHECK (cursor > 0),
    delta_json TEXT NOT NULL,
    PRIMARY KEY (session_id, cursor)
  )`;
  yield* sql`CREATE TABLE deus_receipts (
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    input_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES deus_sessions(session_id),
    command_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (environment_id, project_id, input_id)
  )`;
  yield* sql`CREATE TABLE deus_outbox (
    session_id TEXT NOT NULL REFERENCES deus_sessions(session_id),
    input_id TEXT NOT NULL,
    cursor INTEGER NOT NULL CHECK (cursor > 0),
    intent_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged')),
    PRIMARY KEY (session_id, input_id)
  )`;
  yield* sql`CREATE TABLE deus_worker_links (
    session_id TEXT NOT NULL REFERENCES deus_sessions(session_id),
    task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE,
    command_id TEXT NOT NULL UNIQUE,
    conversation INTEGER NOT NULL CHECK (conversation > 0),
    run_id TEXT,
    PRIMARY KEY (session_id, task_id)
  )`;
  // ProjectStore applies deletion in the owning project transaction, including non-HTTP callers.
  yield* sql`CREATE TRIGGER deus_project_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL BEGIN
      UPDATE deus_sessions SET closed_at = NEW.deleted_at WHERE project_id = NEW.project_id;
    END`;
});
