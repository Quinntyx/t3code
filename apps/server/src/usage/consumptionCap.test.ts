import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadConsumptionCap,
  type ThreadConsumptionCapCondition,
} from "@t3tools/contracts";

import { type ConsumptionCapSnapshot, evaluateConsumptionCap } from "./consumptionCap.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const now = Date.parse("2026-11-04T12:00:00.000Z");

const claudeModel = {
  providerInstanceId: claude,
  driver: claudeDriver,
  model: "claude-opus-4-1",
};
const codexModel = { providerInstanceId: codex, driver: codexDriver, model: "gpt-5.4" };

const cap = (
  ...conditions: ReadonlyArray<ThreadConsumptionCapCondition>
): ThreadConsumptionCap => ({ conditions });

const spend = (
  limitUsd: number,
  models?: ThreadConsumptionCapCondition["models"],
): ThreadConsumptionCapCondition => ({
  kind: "spend",
  limitUsd,
  ...(models === undefined ? {} : { models }),
});

const quota = (
  atPercent: number,
  windowKind: "session" | "weekly",
  models?: ThreadConsumptionCapCondition["models"],
): ThreadConsumptionCapCondition => ({
  kind: "quota",
  atPercent,
  windowKind,
  ...(models === undefined ? {} : { models }),
});

const snapshot = (input: {
  readonly models?: ConsumptionCapSnapshot["models"];
  readonly windows?: ConsumptionCapSnapshot["windowsByInstance"];
}): ConsumptionCapSnapshot => ({
  models: input.models ?? [],
  windowsByInstance: input.windows ?? new Map(),
});

const windows = (
  instanceId: ProviderInstanceId,
  entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: "session" | "weekly";
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt: string | null;
  }>,
) => new Map([[instanceId, entries]]);

describe("consumption cap", () => {
  it("stops when the thread's priced API spend reaches a limit over every model", () => {
    const evaluation = evaluateConsumptionCap(
      cap(spend(10)),
      snapshot({
        models: [
          { providerInstanceId: claude, model: "claude-opus-4-1", costUsd: 4 },
          { providerInstanceId: codex, model: "gpt-5.4", costUsd: 6 },
        ],
      }),
      now,
    );
    expect(evaluation.breach?.reason).toBe("Thread API spend $10.00 reached $10.00 cap.");
    expect(evaluation.known).toBe(true);
  });

  it("adds the models a spend condition lists and ignores the rest", () => {
    const scoped = cap(spend(10, [claudeModel, codexModel]));
    expect(
      evaluateConsumptionCap(
        scoped,
        snapshot({
          models: [
            { providerInstanceId: claude, model: "claude-opus-4-1", costUsd: 4 },
            { providerInstanceId: codex, model: "gpt-5.4", costUsd: 6 },
            { providerInstanceId: codex, model: "gpt-5.4-mini", costUsd: 50 },
          ],
        }),
        now,
      ).breach?.reason,
    ).toBe("2 models API spend $10.00 reached $10.00 cap.");

    const oneModel = cap(spend(5, [claudeModel]));
    expect(
      evaluateConsumptionCap(
        oneModel,
        snapshot({
          models: [
            { providerInstanceId: claude, model: "claude-opus-4-1", costUsd: 5 },
            { providerInstanceId: codex, model: "gpt-5.4", costUsd: 1 },
          ],
        }),
        now,
      ).breach?.reason,
    ).toBe("claude-opus-4-1 API spend $5.00 reached $5.00 cap.");
    expect(
      evaluateConsumptionCap(
        oneModel,
        snapshot({
          models: [{ providerInstanceId: codex, model: "gpt-5.4", costUsd: 100 }],
        }),
        now,
      ).breach,
    ).toBeNull();
  });

  it("stops on the first condition a thread meets", () => {
    const evaluation = evaluateConsumptionCap(
      cap(spend(100), quota(80, "session"), spend(1, [codexModel])),
      snapshot({
        models: [{ providerInstanceId: codex, model: "gpt-5.4", costUsd: 1 }],
        windows: windows(claude, [
          { id: "five-hour", kind: "session", label: "5h", usedPercent: 81, resetsAt: null },
        ]),
      }),
      now,
    );
    expect(evaluation.breach?.reason).toBe("5h usage 81% reached 80% cap.");
  });

  it("treats an unpriced model inside a spend condition as unknown, not a zero-dollar clearance", () => {
    const evaluation = evaluateConsumptionCap(
      cap(spend(1, [claudeModel])),
      snapshot({
        models: [{ providerInstanceId: claude, model: "claude-opus-4-1", costUsd: null }],
      }),
      now,
    );
    expect(evaluation.breach).toBeNull();
    expect(evaluation.known).toBe(false);
  });

  it("still stops on priced spend when an unpriced model sits beside it", () => {
    expect(
      evaluateConsumptionCap(
        cap(spend(5)),
        snapshot({
          models: [
            { providerInstanceId: claude, model: "claude-opus-4-1", costUsd: 5 },
            { providerInstanceId: claude, model: "mystery", costUsd: null },
          ],
        }),
        now,
      ).breach?.reason,
    ).toBe("Thread API spend $5.00 reached $5.00 cap.");
  });

  it("stops at the configured session percentage", () => {
    const session = cap(quota(80, "session"));
    expect(
      evaluateConsumptionCap(
        session,
        snapshot({
          windows: windows(claude, [
            { id: "five-hour", kind: "session", label: "5h", usedPercent: 79.9, resetsAt: null },
          ]),
        }),
        now,
      ),
    ).toMatchObject({ breach: null, known: true });
    expect(
      evaluateConsumptionCap(
        session,
        snapshot({
          windows: windows(claude, [
            { id: "five-hour", kind: "session", label: "5h", usedPercent: 80, resetsAt: null },
          ]),
        }),
        now,
      ).breach?.reason,
    ).toBe("5h usage 80% reached 80% cap.");
  });

  it("watches the window kind across every account in an all-models condition", () => {
    expect(
      evaluateConsumptionCap(
        cap(quota(90, "weekly")),
        snapshot({
          windows: new Map([
            [
              claude,
              [
                {
                  id: "claude-weekly",
                  kind: "weekly" as const,
                  label: "Weekly",
                  usedPercent: 40,
                  resetsAt: null,
                },
              ],
            ],
            [
              codex,
              [
                {
                  id: "codex-weekly",
                  kind: "weekly" as const,
                  label: "Codex weekly",
                  usedPercent: 91,
                  resetsAt: null,
                },
              ],
            ],
          ]),
        }),
        now,
      ).breach?.reason,
    ).toBe("Codex weekly usage 91% reached 90% cap.");
  });

  it("watches only the accounts a quota condition's models run on", () => {
    const evaluation = evaluateConsumptionCap(
      cap(quota(50, "session", [claudeModel])),
      snapshot({
        windows: new Map([
          [
            claude,
            [{ id: "c", kind: "session" as const, label: "5h", usedPercent: 10, resetsAt: null }],
          ],
          [
            codex,
            [
              {
                id: "x",
                kind: "session" as const,
                label: "Codex",
                usedPercent: 99,
                resetsAt: null,
              },
            ],
          ],
        ]),
      }),
      now,
    );
    expect(evaluation).toMatchObject({ breach: null, known: true });
    expect(
      evaluateConsumptionCap(
        cap(quota(50, "session", [claudeModel])),
        snapshot({
          windows: windows(claude, [
            { id: "c", kind: "session", label: "5h", usedPercent: 50, resetsAt: null },
          ]),
        }),
        now,
      ).breach?.reason,
    ).toBe("5h usage 50% reached 50% cap.");
  });

  it("treats a missing quota window as unknown rather than under cap", () => {
    expect(evaluateConsumptionCap(cap(quota(80, "session")), snapshot({}), now)).toMatchObject({
      breach: null,
      known: false,
    });
    expect(
      evaluateConsumptionCap(
        cap(quota(80, "session", [claudeModel])),
        snapshot({ windows: windows(codex, []) }),
        now,
      ),
    ).toMatchObject({ breach: null, known: false });
  });

  it("ignores a window whose reset time has passed", () => {
    expect(
      evaluateConsumptionCap(
        cap(quota(50, "session")),
        snapshot({
          windows: windows(claude, [
            {
              id: "five-hour",
              kind: "session",
              label: "5h",
              usedPercent: 100,
              resetsAt: "2026-11-04T11:59:00.000Z",
            },
          ]),
        }),
        now,
      ),
    ).toMatchObject({ breach: null, known: true });
  });
});
