import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ThreadConsumptionCap } from "./threadConsumptionCap.ts";

const decode = Schema.decodeUnknownSync(ThreadConsumptionCap);
const model = {
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  model: "claude-opus-4-1",
};

describe("thread consumption cap", () => {
  it("holds spend and quota conditions side by side", () => {
    expect(
      decode({
        conditions: [
          { kind: "spend", limitUsd: 20 },
          { kind: "spend", models: [model], limitUsd: 5 },
          { kind: "quota", atPercent: 80, windowKind: "session" },
          { kind: "quota", models: [model], atPercent: 90, windowKind: "weekly" },
        ],
      }).conditions,
    ).toHaveLength(4);
  });

  it("rejects a scope with no models and a threshold outside its kind", () => {
    expect(() => decode({ conditions: [{ kind: "spend", models: [], limitUsd: 5 }] })).toThrow();
    expect(() => decode({ conditions: [{ kind: "spend" }] })).toThrow();
    expect(() =>
      decode({ conditions: [{ kind: "quota", atPercent: 0, windowKind: "session" }] }),
    ).toThrow();
    expect(() => decode({ conditions: [{ kind: "quota", atPercent: 80 }] })).toThrow();
  });
});
