import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadConsumptionCap,
} from "@t3tools/contracts";

import { type ConsumptionCapSnapshot, evaluateConsumptionCap } from "./consumptionCap.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const now = Date.parse("2026-11-04T12:00:00.000Z");

const apiCap = (input: {
  readonly totalLimitUsd?: number;
  readonly rules?: ThreadConsumptionCap["rules"];
}): ThreadConsumptionCap => ({
  mode: "api",
  ...(input.totalLimitUsd === undefined ? {} : { totalLimitUsd: input.totalLimitUsd }),
  rules: input.rules ?? [],
});

const snapshot = (input: {
  readonly models?: ConsumptionCapSnapshot["models"];
  readonly windows?: ConsumptionCapSnapshot["windowsByInstance"];
}): ConsumptionCapSnapshot => ({
  models: input.models ?? [],
  windowsByInstance: input.windows ?? new Map(),
});

const quotaCap = (input: {
  readonly windowId?: string;
  readonly windowKind?: ThreadConsumptionCap["rules"][number]["windowKind"];
  readonly atPercent?: number;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly driver?: ThreadConsumptionCap["rules"][number]["driver"];
}): ThreadConsumptionCap => ({
  mode: "quota",
  rules: [
    {
      providerInstanceId: input.providerInstanceId ?? claude,
      driver: input.driver ?? claudeDriver,
      model: "claude-opus-4-1",
      ...(input.windowId === undefined ? {} : { windowId: input.windowId }),
      ...(input.windowKind === undefined ? {} : { windowKind: input.windowKind }),
      atPercent: input.atPercent ?? 80,
    },
  ],
});

const windows = (
  instanceId: ProviderInstanceId,
  entries: ReadonlyArray<
    ConsumptionCapSnapshot["windowsByInstance"] extends ReadonlyMap<string, infer W>
      ? W extends ReadonlyArray<infer X>
        ? X
        : never
      : never
  >,
) => new Map([[instanceId, entries]]);

describe("consumption cap", () => {
  it("stops when the thread's priced API spend reaches the total", () => {
    const evaluation = evaluateConsumptionCap(
      apiCap({ totalLimitUsd: 10 }),
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

  it("stops one model without stopping on another model's spend", () => {
    const cap = apiCap({
      rules: [
        {
          providerInstanceId: claude,
          driver: claudeDriver,
          model: "claude-opus-4-1",
          limitUsd: 5,
        },
      ],
    });
    expect(
      evaluateConsumptionCap(
        cap,
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
        cap,
        snapshot({
          models: [{ providerInstanceId: codex, model: "gpt-5.4", costUsd: 100 }],
        }),
        now,
      ).breach,
    ).toBeNull();
  });

  it("treats an unpriced model as unknown, not a zero-dollar clearance", () => {
    const evaluation = evaluateConsumptionCap(
      apiCap({
        totalLimitUsd: 1,
        rules: [
          {
            providerInstanceId: claude,
            driver: claudeDriver,
            model: "mystery-model",
            limitUsd: 1,
          },
        ],
      }),
      snapshot({
        models: [{ providerInstanceId: claude, model: "mystery-model", costUsd: null }],
      }),
      now,
    );
    expect(evaluation.breach).toBeNull();
    expect(evaluation.known).toBe(false);
  });

  it("stops at the configured session percentage", () => {
    const cap = quotaCap({ windowId: "five-hour", windowKind: "session" });
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          windows: windows(claude, [
            {
              id: "five-hour",
              kind: "session",
              label: "5h",
              usedPercent: 79.9,
              resetsAt: null,
            },
          ]),
        }),
        now,
      ),
    ).toMatchObject({ breach: null, known: true });
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          windows: windows(claude, [
            {
              id: "five-hour",
              kind: "session",
              label: "5h",
              usedPercent: 80,
              resetsAt: null,
            },
          ]),
        }),
        now,
      ).breach?.reason,
    ).toBe("5h usage 80% reached 80% cap.");
  });

  it("falls back to the window kind when the provider changes the window id", () => {
    expect(
      evaluateConsumptionCap(
        quotaCap({
          providerInstanceId: codex,
          driver: codexDriver,
          windowId: "old-weekly",
          windowKind: "weekly",
          atPercent: 90,
        }),
        snapshot({
          windows: windows(codex, [
            {
              id: "new-weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 91,
              resetsAt: null,
            },
          ]),
        }),
        now,
      ).breach?.reason,
    ).toBe("Weekly usage 91% reached 90% cap.");
  });

  it("treats a missing quota window as unknown rather than under cap", () => {
    expect(
      evaluateConsumptionCap(quotaCap({ windowKind: "session" }), snapshot({}), now),
    ).toMatchObject({ breach: null, known: false });
  });

  it("ignores a window whose reset time has passed", () => {
    expect(
      evaluateConsumptionCap(
        quotaCap({ windowKind: "session", atPercent: 50 }),
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
