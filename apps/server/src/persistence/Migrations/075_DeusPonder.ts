import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE deus_learning_projects (
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
    model_json TEXT,
    PRIMARY KEY (environment_id, project_id)
  )`;
  yield* sql`CREATE TABLE deus_ponder_acknowledgments (
    observation_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    ponder_id TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE deus_ponder_runs (
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    local_date TEXT NOT NULL,
    run_json TEXT NOT NULL,
    PRIMARY KEY (environment_id, project_id, local_date)
  )`;
});
