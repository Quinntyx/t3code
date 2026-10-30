import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Consumed identities are replay barriers, never grants. Active grants live only in owner scopes.
  yield* sql`CREATE TABLE deus_authority_claims (
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    input_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES deus_sessions(session_id),
    PRIMARY KEY (environment_id, project_id, input_id)
  )`;
  yield* sql`CREATE TABLE deus_media_generations (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES deus_sessions(session_id),
    generation INTEGER NOT NULL CHECK (generation > 0)
  )`;
});
