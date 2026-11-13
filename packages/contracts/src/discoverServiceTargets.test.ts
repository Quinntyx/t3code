import { assert, describe, it } from "@effect/vitest";

import {
  discoverServiceEnvironmentNames,
  discoverServiceProviderEnvironment,
  discoverServiceSupportsDriver,
  mergeProviderInstanceEnvironment,
} from "./discoverServiceTargets.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const credential = {
  protocol: "openai" as const,
  baseUrl: "http://hub.example:8317/v1",
  apiKey: "t3d-secret",
};

const anthropicCredential = {
  ...credential,
  protocol: "anthropic" as const,
  baseUrl: "http://hub.example:8317",
};

describe("discoverServiceProviderEnvironment", () => {
  it("points Claude Code at the hub with its documented variables", () => {
    assert.deepEqual(
      discoverServiceProviderEnvironment({
        driver: ProviderDriverKind.make("claudeAgent"),
        serviceId: "cliproxy",
        credential: anthropicCredential,
      }),
      [
        { name: "ANTHROPIC_BASE_URL", value: "http://hub.example:8317", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "t3d-secret", sensitive: true },
      ],
    );
  });

  it("points Codex at the hub with its documented variables", () => {
    assert.deepEqual(
      discoverServiceProviderEnvironment({
        driver: ProviderDriverKind.make("codex"),
        serviceId: "cliproxy",
        credential,
      }),
      [
        { name: "OPENAI_BASE_URL", value: "http://hub.example:8317/v1", sensitive: false },
        { name: "OPENAI_API_KEY", value: "t3d-secret", sensitive: true },
      ],
    );
  });

  it("gives Pi namespaced variables its injected extension reads", () => {
    assert.deepEqual(
      discoverServiceProviderEnvironment({
        driver: ProviderDriverKind.make("pi"),
        serviceId: "cli-proxy",
        credential,
      }),
      [
        {
          name: "T3_DISCOVER_CLI_PROXY_BASE_URL",
          value: "http://hub.example:8317/v1",
          sensitive: false,
        },
        { name: "T3_DISCOVER_CLI_PROXY_API_KEY", value: "t3d-secret", sensitive: true },
        { name: "T3_DISCOVER_CLI_PROXY_API", value: "openai-completions", sensitive: false },
      ],
    );
  });

  it("refuses a protocol the harness cannot speak", () => {
    assert.isNull(
      discoverServiceProviderEnvironment({
        driver: ProviderDriverKind.make("claudeAgent"),
        serviceId: "cliproxy",
        credential,
      }),
    );
    assert.isNull(
      discoverServiceProviderEnvironment({
        driver: ProviderDriverKind.make("codex"),
        serviceId: "cliproxy",
        credential: anthropicCredential,
      }),
    );
    assert.isNull(
      discoverServiceProviderEnvironment({
        driver: ProviderDriverKind.make("cursor"),
        serviceId: "cliproxy",
        credential,
      }),
    );
  });

  it("reports support per driver and protocol", () => {
    assert.isTrue(discoverServiceSupportsDriver(ProviderDriverKind.make("codex"), "openai"));
    assert.isFalse(discoverServiceSupportsDriver(ProviderDriverKind.make("codex"), "anthropic"));
    assert.isTrue(discoverServiceSupportsDriver(ProviderDriverKind.make("pi"), "anthropic"));
  });
});

describe("discoverServiceEnvironmentNames", () => {
  it("produces a stable slug for ids with punctuation", () => {
    assert.deepEqual(discoverServiceEnvironmentNames("a.b/c d"), {
      baseUrl: "T3_DISCOVER_A_B_C_D_BASE_URL",
      apiKey: "T3_DISCOVER_A_B_C_D_API_KEY",
      label: "T3_DISCOVER_A_B_C_D_LABEL",
      api: "T3_DISCOVER_A_B_C_D_API",
    });
  });

  it("keeps distinct ids from sharing variables", () => {
    // Two services that collide here would overwrite each other's provider configuration.
    const names = ["hub", "hub-", "hub-a", "hub--a", "hub-a-"].map(
      (serviceId) => discoverServiceEnvironmentNames(serviceId).baseUrl,
    );
    assert.deepEqual(names, [
      "T3_DISCOVER_HUB_BASE_URL",
      "T3_DISCOVER_HUB__BASE_URL",
      "T3_DISCOVER_HUB_A_BASE_URL",
      "T3_DISCOVER_HUB__A_BASE_URL",
      "T3_DISCOVER_HUB_A__BASE_URL",
    ]);
    assert.strictEqual(new Set(names).size, names.length);
  });
});

describe("mergeProviderInstanceEnvironment", () => {
  it("replaces target names and keeps redacted secrets", () => {
    const merged = mergeProviderInstanceEnvironment(
      [
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true },
        { name: "KEEP_ME", value: "1", sensitive: false },
      ],
      [
        { name: "ANTHROPIC_BASE_URL", value: "http://hub", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "fresh", sensitive: true },
      ],
    );
    assert.deepEqual(merged, [
      { name: "KEEP_ME", value: "1", sensitive: false },
      { name: "ANTHROPIC_BASE_URL", value: "http://hub", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "fresh", sensitive: true },
    ]);
  });
});
