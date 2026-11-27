import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { poolSources, resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("claudeAgent");

function limitsAt(usedPercent: number): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

interface HubAccountInput {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly models?: readonly string[];
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  origin = "http://127.0.0.1:8317",
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    origin,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.models ? { models: account.models } : {}),
      usageLimits: account.limits,
    })),
  };
}

function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  model: string | null,
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    model,
    [claudeInstance(own)],
    sources,
    now,
  );
  if (resolved?.kind !== "pool") return resolved;
  return {
    kind: resolved.kind,
    rows: resolved.windows.map((window) => ({
      label: window.label,
      left: window.remainingPercent,
      accounts: window.members.length,
      from: poolSources(window),
    })),
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("keeps an instance's failed reading instead of a hub it is not sent to", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const direct = { ...claudeInstance(failed), auth: { status: "authenticated" as const } };
    const elsewhere = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    const otherHub = hub("Other", [{ id: "a.json", limits: limitsAt(20) }], "http://hub");
    expect(resolveThreadDetailsLimits(instanceId, null, [direct], [readableHub], now)).toEqual({
      kind: "instance",
      limits: failed,
    });
    expect(resolveThreadDetailsLimits(instanceId, null, [elsewhere], [otherHub], now)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });

  it("pools only the accounts the hub routes the model to, even of another driver", () => {
    const sources = [
      hub("Hub", [
        { id: "a.json", models: ["claude-opus-5-5"], limits: limitsAt(10) },
        { id: "c.json", driver: codex, models: ["gpt-5.6-sol"], limits: limitsAt(30) },
      ]),
    ];
    expect(shown(unsupported, sources, "gpt-5.6-sol[1m]")).toEqual({
      kind: "pool",
      rows: [{ label: "Session", left: 70, accounts: 1, from: { hubs: ["Hub"], signedIn: false } }],
    });
  });

  it("resolves pooled hub limits for a Pi instance with usageRoutes and no own usageLimits", () => {
    const piId = ProviderInstanceId.make("pi");
    const piProvider: ServerProvider = {
      ...claudeInstance(unsupported),
      instanceId: piId,
      driver: ProviderDriverKind.make("pi"),
      auth: { status: "authenticated" },
      usageLimits: undefined,
      usageRoutes: [{ origin: "http://localhost:8317", driver: claude }],
    };
    const sources = [
      hub(
        "Hub",
        [{ id: "a.json", models: ["claude-opus-4-6"], limits: limitsAt(25) }],
        "http://127.0.0.1:8317",
      ),
    ];
    const resolved = resolveThreadDetailsLimits(
      piId,
      "cliproxyapi/claude-opus-4-6",
      [piProvider],
      sources,
      now,
    );
    expect(resolved?.kind).toBe("pool");
    if (resolved?.kind === "pool") {
      expect(resolved.windows.map((window) => window.remainingPercent)).toEqual([75]);
    }
  });

  it("selects hub pool vs local OpenCode Go vs ChatGPT usageSource per Pi model family", () => {
    const piId = ProviderInstanceId.make("pi-multi");
    const opencode = ProviderDriverKind.make("opencode");
    const opencodeLimits: ServerProviderUsageLimits = {
      ...limitsAt(15),
      ownerDriver: opencode,
    };
    const chatgptLimits = limitsAt(40);
    const piProvider: ServerProvider = {
      ...claudeInstance(unsupported),
      instanceId: piId,
      driver: ProviderDriverKind.make("pi"),
      auth: { status: "authenticated" },
      usageLimits: opencodeLimits,
      usageSources: [
        {
          id: "chatgpt",
          label: "ChatGPT",
          driver: codex,
          limits: chatgptLimits,
        },
      ],
      usageRoutes: [{ origin: "http://localhost:8317", driver: claude }],
    };
    const sources = [
      hub(
        "Hub",
        [{ id: "a.json", models: ["claude-opus-4-6"], limits: limitsAt(25) }],
        "http://127.0.0.1:8317",
      ),
    ];
    // Routed CLIProxyAPI model shows the hub Claude pool, not local ChatGPT or OpenCode Go.
    const hubResolved = resolveThreadDetailsLimits(
      piId,
      "cliproxyapi/claude-opus-4-6",
      [piProvider],
      sources,
      now,
    );
    expect(hubResolved?.kind).toBe("pool");
    if (hubResolved?.kind === "pool") {
      expect(hubResolved.windows.map((window) => window.remainingPercent)).toEqual([75]);
    }
    // Direct OpenCode Go model shows Pi's ownerDriver=opencode usageLimits.
    expect(
      resolveThreadDetailsLimits(piId, "opencode-go/glm-5", [piProvider], sources, now),
    ).toEqual({ kind: "instance", limits: opencodeLimits });
    // Direct Codex model shows Pi's ChatGPT usageSource.
    expect(
      resolveThreadDetailsLimits(piId, "openai-codex/gpt-5.4", [piProvider], sources, now),
    ).toEqual({ kind: "instance", limits: chatgptLimits });
    // Unrelated direct model or offline CLIProxyAPI hub returns null, never leaking OpenCode Go limits.
    expect(
      resolveThreadDetailsLimits(piId, "anthropic/claude-opus-4-6", [piProvider], sources, now),
    ).toBeNull();
    expect(
      resolveThreadDetailsLimits(piId, "cliproxyapi/claude-opus-4-6", [piProvider], [], now),
    ).toBeNull();
    // A non-Pi instance routed to an unreadable hub must not fall back to local CLI limits.
    const claudeRouted: ServerProvider = {
      ...claudeInstance(limitsAt(95)),
      auth: { status: "authenticated", endpoint: "http://127.0.0.1:8317" },
    };
    const erroredHub = [
      {
        ...hub("Hub", [], "http://127.0.0.1:8317"),
        error: "hub unavailable",
      },
    ];
    expect(
      resolveThreadDetailsLimits(
        claudeRouted.instanceId,
        "claude-opus-4-6",
        [claudeRouted],
        erroredHub,
        now,
      ),
    ).toBeNull();
    // When Pi's ChatGPT usageSource matches a Codex hub account, hubPool strips unrelated OpenCode Go limits.
    const codexPi: ServerProvider = {
      ...piProvider,
      usageRoutes: [{ origin: "http://localhost:8317", driver: codex }],
      usageSources: [
        {
          id: "chatgpt",
          label: "ChatGPT",
          driver: codex,
          email: "same@example.com",
          limits: chatgptLimits,
        },
      ],
    };
    const codexHub = [
      {
        ...hub(
          "Hub",
          [{ id: "c.json", driver: codex, models: ["gpt-5.4"], limits: limitsAt(50) }],
          "http://127.0.0.1:8317",
        ),
        accounts: [
          {
            id: "c.json",
            driver: codex,
            email: "same@example.com",
            models: ["gpt-5.4"],
            usageLimits: limitsAt(50),
          },
        ],
      },
    ];
    const codexPool = resolveThreadDetailsLimits(
      piId,
      "cliproxyapi/gpt-5.4",
      [codexPi],
      codexHub,
      now,
    );
    expect(codexPool?.kind).toBe("pool");
    if (codexPool?.kind === "pool") {
      expect(codexPool.windows).toHaveLength(1);
      expect(codexPool.windows[0]?.remainingPercent).toBe(60);
    }
  });

  it("filters model-scoped windows on fresher matching local logins before pooling", () => {
    const fresherCheckedAt = "2026-10-30T11:59:30.000Z";
    const claudeRouted: ServerProvider = {
      ...claudeInstance(unsupported),
      auth: {
        status: "authenticated",
        type: "customEndpoint",
        endpoint: "http://127.0.0.1:8317",
      },
    };
    const localClaude: ServerProvider = {
      ...claudeInstance({
        checkedAt: fresherCheckedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 15,
            windowDurationMins: 300,
            resetsAt: "2026-10-30T13:17:00.000Z",
          },
          {
            id: "seven_day_opus",
            kind: "weekly",
            label: "Opus weekly",
            usedPercent: 95,
            windowDurationMins: 10_080,
            resetsAt: "2026-11-05T13:17:00.000Z",
          },
        ],
      }),
      instanceId: ProviderInstanceId.make("claude-local"),
      auth: {
        status: "authenticated",
        email: "alice@example.com",
      },
    };
    const claudeHub: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("Hub"),
      kind: "cliproxy",
      label: "Hub",
      origin: "http://127.0.0.1:8317",
      checkedAt,
      accounts: [
        {
          id: "alice.json",
          driver: claude,
          email: "alice@example.com",
          models: ["claude-sonnet-4-6", "claude-opus-4-6"],
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 40,
                windowDurationMins: 300,
                resetsAt: "2026-10-30T13:17:00.000Z",
              },
              {
                id: "seven_day_opus",
                kind: "weekly",
                label: "Opus weekly",
                usedPercent: 80,
                windowDurationMins: 10_080,
                resetsAt: "2026-11-05T13:17:00.000Z",
              },
            ],
          },
        },
      ],
    };

    const sonnet = resolveThreadDetailsLimits(
      claudeRouted.instanceId,
      "claude-sonnet-4-6",
      [claudeRouted, localClaude],
      [claudeHub],
      now,
    );
    expect(sonnet?.kind).toBe("pool");
    if (sonnet?.kind === "pool") {
      // Uses the fresher local five_hour (85% left) while excluding seven_day_opus on Sonnet.
      expect(sonnet.windows.map((window) => [window.id, window.remainingPercent])).toEqual([
        ["five_hour", 85],
      ]);
    }

    const opus = resolveThreadDetailsLimits(
      claudeRouted.instanceId,
      "claude-opus-4-6",
      [claudeRouted, localClaude],
      [claudeHub],
      now,
    );
    expect(opus?.kind).toBe("pool");
    if (opus?.kind === "pool") {
      expect(opus.windows.map((window) => [window.id, window.remainingPercent])).toEqual([
        ["five_hour", 85],
        ["seven_day_opus", 5],
      ]);
    }
  });
});
