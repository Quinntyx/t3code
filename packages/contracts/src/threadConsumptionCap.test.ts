import { describe, expect, it } from "@effect/vitest";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  type ThreadConsumptionCap,
  type ThreadConsumptionCapRule,
  consumptionCapIsMorePermissive,
} from "./threadConsumptionCap.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");

const apiRule = (
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  limitUsd: number,
): ThreadConsumptionCapRule => ({
  providerInstanceId,
  driver,
  model: "model",
  limitUsd,
});

const quotaRule = (
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  atPercent: number,
  windowId = "session",
): ThreadConsumptionCapRule => ({
  providerInstanceId,
  driver,
  model: "model",
  windowId,
  windowKind: "session",
  atPercent,
});

const apiCap = (input: {
  readonly totalLimitUsd?: number;
  readonly rules?: ReadonlyArray<ThreadConsumptionCapRule>;
}): ThreadConsumptionCap => ({
  mode: "api",
  ...(input.totalLimitUsd === undefined ? {} : { totalLimitUsd: input.totalLimitUsd }),
  rules: input.rules ?? [],
});

const quotaCap = (rules: ReadonlyArray<ThreadConsumptionCapRule>): ThreadConsumptionCap => ({
  mode: "quota",
  rules,
});

describe("consumption cap permissiveness", () => {
  it("treats removing the cap as more permissive", () => {
    expect(consumptionCapIsMorePermissive(null, apiCap({ totalLimitUsd: 10 }))).toBe(true);
  });

  it("clears only when every limit is raised or removed", () => {
    expect(
      consumptionCapIsMorePermissive(
        apiCap({ totalLimitUsd: 20, rules: [apiRule(claude, claudeDriver, 10)] }),
        apiCap({ totalLimitUsd: 10, rules: [apiRule(claude, claudeDriver, 5)] }),
      ),
    ).toBe(true);
    expect(
      consumptionCapIsMorePermissive(
        apiCap({ totalLimitUsd: 20, rules: [apiRule(claude, claudeDriver, 4)] }),
        apiCap({ totalLimitUsd: 10, rules: [apiRule(claude, claudeDriver, 5)] }),
      ),
    ).toBe(false);
    expect(
      consumptionCapIsMorePermissive(
        apiCap({ totalLimitUsd: 10, rules: [apiRule(claude, claudeDriver, 5)] }),
        apiCap({ totalLimitUsd: 10, rules: [apiRule(claude, claudeDriver, 5)] }),
      ),
    ).toBe(false);
  });

  it("treats a new rule as stricter and a removed rule as looser", () => {
    const previous = apiCap({ rules: [apiRule(claude, claudeDriver, 5)] });
    expect(
      consumptionCapIsMorePermissive(
        apiCap({ rules: [apiRule(claude, claudeDriver, 5), apiRule(codex, codexDriver, 5)] }),
        previous,
      ),
    ).toBe(false);
    expect(consumptionCapIsMorePermissive(apiCap({ rules: [] }), previous)).toBe(true);
  });

  it("keeps the hit when a quota window or threshold gets stricter", () => {
    expect(
      consumptionCapIsMorePermissive(
        quotaCap([quotaRule(claude, claudeDriver, 90)]),
        quotaCap([quotaRule(claude, claudeDriver, 80)]),
      ),
    ).toBe(true);
    expect(
      consumptionCapIsMorePermissive(
        quotaCap([quotaRule(claude, claudeDriver, 70)]),
        quotaCap([quotaRule(claude, claudeDriver, 80)]),
      ),
    ).toBe(false);
    expect(
      consumptionCapIsMorePermissive(
        quotaCap([quotaRule(claude, claudeDriver, 90, "weekly")]),
        quotaCap([quotaRule(claude, claudeDriver, 80, "session")]),
      ),
    ).toBe(false);
  });
});
