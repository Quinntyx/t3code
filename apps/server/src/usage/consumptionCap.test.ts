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

describe("consumption cap", () => {
  it("stops when the thread's priced API spend reaches the total", () => {
    const breach = evaluateConsumptionCap(
      apiCap({ totalLimitUsd: 10 }),
      snapshot({
        models: [
          { providerInstanceId: claude, model: "claude-opus-4-1", costUsd: 4 },
          { providerInstanceId: codex, model: "gpt-5.4", costUsd: 6 },
        ],
      }),
      now,
    );
    expect(breach?.reason).toBe("Thread API spend $10.00 reached $10.00 cap.");
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
      )?.reason,
    ).toBe("claude-opus-4-1 API spend $5.00 reached $5.00 cap.");
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          models: [{ providerInstanceId: codex, model: "gpt-5.4", costUsd: 100 }],
        }),
        now,
      ),
    ).toBeNull();
  });

  it("treats an unpriced model as no spend rather than a zero-dollar hit", () => {
    expect(
      evaluateConsumptionCap(
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
      ),
    ).toBeNull();
  });

  it("stops at the configured session percentage", () => {
    const cap: ThreadConsumptionCap = {
      mode: "quota",
      rules: [
        {
          providerInstanceId: claude,
          driver: claudeDriver,
          model: "claude-opus-4-1",
          windowId: "five-hour",
          windowKind: "session",
          atPercent: 80,
        },
      ],
    };
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          windows: new Map([
            [
              claude,
              [
                {
                  id: "five-hour",
                  kind: "session",
                  label: "5h",
                  usedPercent: 79.9,
                  resetsAt: null,
                },
              ],
            ],
          ]),
        }),
        now,
      ),
    ).toBeNull();
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          windows: new Map([
            [
              claude,
              [
                {
                  id: "five-hour",
                  kind: "session",
                  label: "5h",
                  usedPercent: 80,
                  resetsAt: null,
                },
              ],
            ],
          ]),
        }),
        now,
      )?.reason,
    ).toBe("5h usage 80% reached 80% cap.");
  });

  it("falls back to the window kind when the provider changes the window id", () => {
    const cap: ThreadConsumptionCap = {
      mode: "quota",
      rules: [
        {
          providerInstanceId: codex,
          driver: codexDriver,
          model: "gpt-5.4",
          windowId: "old-weekly",
          windowKind: "weekly",
          atPercent: 90,
        },
      ],
    };
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          windows: new Map([
            [
              codex,
              [
                {
                  id: "new-weekly",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 91,
                  resetsAt: null,
                },
              ],
            ],
          ]),
        }),
        now,
      )?.reason,
    ).toBe("Weekly usage 91% reached 90% cap.");
  });

  it("ignores a window whose reset time has passed", () => {
    const cap: ThreadConsumptionCap = {
      mode: "quota",
      rules: [
        {
          providerInstanceId: claude,
          driver: claudeDriver,
          model: "claude-opus-4-1",
          windowKind: "session",
          atPercent: 50,
        },
      ],
    };
    expect(
      evaluateConsumptionCap(
        cap,
        snapshot({
          windows: new Map([
            [
              claude,
              [
                {
                  id: "five-hour",
                  kind: "session",
                  label: "5h",
                  usedPercent: 100,
                  resetsAt: "2026-11-04T11:59:00.000Z",
                },
              ],
            ],
          ]),
        }),
        now,
      ),
    ).toBeNull();
  });
});
