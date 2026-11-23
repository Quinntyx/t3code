import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import VoiceNotificationIndex from "./Migrations/111_VoiceNotificationIndex.ts";
import SubagentLineageIndex from "./Migrations/112_SubagentLineageIndex.ts";
import { reconciledForkHistory } from "./reconcileForkMigration.ts";

// Historical fork migration 81 lacked `json_valid(payload_json)` before migration 103 hardened it.
const LegacyVoiceNotificationIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_voice_idx
    ON orchestration_v2_projection_turn_items(updated_at DESC, ordinal DESC, turn_item_id DESC)
    WHERE type = 'system_notice' AND json_type(payload_json, '$.voiceNotification') = 'object'
  `;
});

const readHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const readIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string; readonly sql: string }>`
    SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
  `;
  return new Map(rows.map((row) => [row.name, row.sql]));
});

describe("legacy fork migration reconciliation", () => {
  it.effect.each([false, true])(
    "upgrades legacy fork database through 81 (with 82=%s) onto upstream 81..102 + fork 103..104",
    (withSubagentIndex) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 80 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "81_VoiceNotificationIndex": LegacyVoiceNotificationIndex,
            ...(withSubagentIndex ? { "82_SubagentLineageIndex": SubagentLineageIndex } : {}),
          }),
        });

        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed,
          migrationManifest.filter(([id]) => id >= 81),
        );
        assert.deepStrictEqual(yield* readHistory, migrationManifest);
        const indexes = yield* readIndexes;
        const voiceIndexSql = indexes.get("orchestration_v2_projection_turn_items_voice_idx");
        assert.isDefined(voiceIndexSql);
        assert.include(voiceIndexSql, "json_valid(payload_json)");
        assert.isTrue(indexes.has("orchestration_v2_projection_threads_subagent_parent_idx"));

        // Malformed system_notice JSON must not fail index maintenance after migration 103 rebuilds it.
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            'item-bad-json', 'thread-1', 1, 'system_notice', 'completed', '2026-01-01T00:00:00.000Z', '{bad'
          )
        `;

        // Second startup must be an idempotent read-only no-op.
        yield* sql`PRAGMA query_only = ON`;
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades prior fork database through 103 (with 104=%s) onto upstream 103..110 + fork 111..112",
    (withSubagentIndex) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 102 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "103_VoiceNotificationIndex": VoiceNotificationIndex,
            ...(withSubagentIndex ? { "104_SubagentLineageIndex": SubagentLineageIndex } : {}),
          }),
        });

        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed,
          migrationManifest.filter(([id]) => id >= 103),
        );
        assert.deepStrictEqual(yield* readHistory, migrationManifest);
        const indexes = yield* readIndexes;
        assert.isDefined(indexes.get("orchestration_v2_projection_turn_items_voice_idx"));
        assert.isTrue(indexes.has("orchestration_v2_projection_threads_subagent_parent_idx"));

        yield* sql`PRAGMA query_only = ON`;
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "respects bounded toMigrationInclusive targets without rewriting untouched later rows",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 80 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "81_VoiceNotificationIndex": LegacyVoiceNotificationIndex,
            "82_SubagentLineageIndex": SubagentLineageIndex,
          }),
        });
        const before = yield* readHistory;

        // Targeting <= 80 must leave legacy 81/82 untouched.
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 80 }), []);
        assert.deepStrictEqual(yield* readHistory, before);

        // Targeting 81 removes the full legacy tail so canonical 81 actually runs.
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 81 }), [
          [81, "ProjectionMessageSearchText"],
        ]);
        assert.deepStrictEqual(
          yield* readHistory,
          migrationManifest.filter(([id]) => id <= 81),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects invalid fork tails without modifying the ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (81, 'VoiceNotificationIndex'), (83, 'CommandReadIndexes')
      `;
      const before = yield* readHistory;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* readHistory, before);
      assert.isNull(reconciledForkHistory(before.map(([id, name]) => ({ id, name }))));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects fork 82 alone without 81 and rejects inconsistent V2 prefix", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (82, 'SubagentLineageIndex')
      `;
      const beforeOnly82 = yield* readHistory;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* readHistory, beforeOnly82);

      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (81, 'VoiceNotificationIndex')
      `;
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'TamperedMigration' WHERE migration_id = 75
      `;
      const beforeCorruptPrefix = yield* readHistory;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* readHistory, beforeCorruptPrefix);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
