import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_voice_idx
    ON orchestration_v2_projection_turn_items(updated_at DESC, ordinal DESC, turn_item_id DESC)
    WHERE type = 'system_notice' AND json_type(payload_json, '$.voiceNotification') = 'object'
  `;
});
