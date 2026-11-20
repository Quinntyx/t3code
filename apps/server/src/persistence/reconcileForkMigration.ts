import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

type MigrationRow = { readonly id: number; readonly name: string };

export const LEGACY_FORK_MIGRATION_START_ID = 81;

const LEGACY_FORK_TAIL = [
  { id: 81, name: "VoiceNotificationIndex" },
  { id: 82, name: "SubagentLineageIndex" },
] as const;

type ForkTailClassification =
  | { readonly kind: "none" }
  | { readonly kind: "legacy"; readonly rows: ReadonlyArray<MigrationRow> }
  | { readonly kind: "invalid"; readonly offending: ReadonlyArray<string> };

const isLegacyForkRow = (row: MigrationRow): boolean =>
  LEGACY_FORK_TAIL.some((entry) => entry.id === row.id && entry.name === row.name);

// Older fork builds recorded index-only migrations at 81/82 before upstream claimed those ids.
export function classifyLegacyForkTail(
  history: ReadonlyArray<MigrationRow>,
): ForkTailClassification {
  const later = history
    .filter((row) => row.id >= LEGACY_FORK_MIGRATION_START_ID)
    .toSorted((a, b) => a.id - b.id);
  if (!later.some(isLegacyForkRow)) {
    return { kind: "none" };
  }
  const matchesPartial =
    later.length === 1 &&
    later[0]?.id === LEGACY_FORK_TAIL[0].id &&
    later[0]?.name === LEGACY_FORK_TAIL[0].name;
  const matchesFull =
    later.length === 2 &&
    later[0]?.id === LEGACY_FORK_TAIL[0].id &&
    later[0]?.name === LEGACY_FORK_TAIL[0].name &&
    later[1]?.id === LEGACY_FORK_TAIL[1].id &&
    later[1]?.name === LEGACY_FORK_TAIL[1].name;
  if (matchesPartial || matchesFull) {
    return { kind: "legacy", rows: later };
  }
  return {
    kind: "invalid",
    offending: later.map((row) => `${row.id}_${row.name}`),
  };
}

/** The history as startup's fork reconciliation leaves it, or null when startup rejects it. */
export function reconciledForkHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  const classified = classifyLegacyForkTail(history);
  if (classified.kind === "none") return history;
  if (classified.kind === "invalid") return null;
  return history.filter((row) => row.id < LEGACY_FORK_MIGRATION_START_ID);
}

export const reconcileForkMigration = Effect.fn("reconcileForkMigration")(function* (
  checkProjectedPrefix: (projected: ReadonlyArray<MigrationRow>) => ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return false;
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const rows = recorded.map((row) => ({ id: row.migration_id, name: row.name }));
      const classified = classifyLegacyForkTail(rows);
      if (classified.kind === "none") return false;
      if (classified.kind === "invalid") {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot upgrade legacy fork database with unexpected migration tail: ${classified.offending.join(", ")}.`,
        });
      }
      const projected = rows.filter((row) => row.id < LEGACY_FORK_MIGRATION_START_ID);
      const skippedPrefix = checkProjectedPrefix(projected);
      if (skippedPrefix.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot reconcile legacy fork migrations because earlier V2 history is inconsistent: ${skippedPrefix.join(", ")}.`,
        });
      }
      for (const row of classified.rows) {
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${row.id} AND name = ${row.name}
        `;
      }
      const remaining = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= ${LEGACY_FORK_MIGRATION_START_ID}
      `;
      if (remaining.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Legacy fork migration reconciliation left unexpected rows in effect_sql_migrations.",
        });
      }
      return true;
    }),
  );
});
