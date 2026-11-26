import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Stall recovery and active-shell liveness scan overloaded failures. Keep this predicate
  // identical to ProjectionStore's overloaded failure filter; json_valid keeps malformed
  // payloads writable.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_overloaded_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.failure.overloaded') = 1
        ELSE 0 END
  `;

  // Active-shell liveness checks thread watches and awaited scheduled tasks through partial
  // indexes so Migration 098's covering index on active threads never falls back to payload_json.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_thread_watches_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN
        json_type(payload_json, '$.threadWatches[0]') IS NOT NULL
        ELSE 0 END
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_awaited_scheduled_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN
        json_type(payload_json, '$.awaitedScheduledTaskIds[0]') IS NOT NULL
        ELSE 0 END
  `;

  // ConsumptionCapWorker sweeps capped threads on every scheduler tick; index only capped rows.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_consumption_cap_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.consumptionCap') IS NOT NULL
        OR json_extract(payload_json, '$.consumptionCapHit') IS NOT NULL
        ELSE 0 END
  `;
});
