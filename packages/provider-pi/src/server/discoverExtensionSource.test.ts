// @effect-diagnostics nodeBuiltinImport:off -- Pi extensions run outside Effect; this loads one into a VM.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_DISCOVER_EXTENSION_SOURCE } from "./discoverExtensionSource.ts";

interface RegistryModel {
  readonly provider: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

async function startSession(env: Record<string, string>, models: ReadonlyArray<RegistryModel>) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const registered: Array<{ name: string; config: { models: ReadonlyArray<RegistryModel> } }> = [];
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_DISCOVER_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nregisterDiscoveredServices(pi)`, {
    process: { env },
    URL,
    pi: {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) =>
        handlers.set(name, handler),
      registerProvider: (name: string, config: { models: ReadonlyArray<RegistryModel> }) =>
        registered.push({ name, config }),
    },
  });
  handlers.get("session_start")?.(
    { type: "session_start" },
    { modelRegistry: { getAll: () => models } },
  );
  return registered;
}

const sol = {
  provider: "cliproxyapi",
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  api: "openai-codex-responses",
  baseUrl: "http://hub.test:8317/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  contextWindow: 400000,
  maxTokens: 128000,
};
const direct = {
  provider: "openrouter",
  id: "deepseek/deepseek-v4.1-flash-1017",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
};

describe("Pi hub model catalogs", () => {
  it("adds a hub's unlisted models to each provider on that hub's host", async () => {
    const env = {
      T3_HUB_MODELS: JSON.stringify([
        {
          url: "http://hub.test:8317/management.html",
          models: ["gpt-6.1-sol", "my-custom-model", "my-custom-model:fast"],
        },
      ]),
    };

    const registered = await startSession(env, [sol, direct]);

    assert.deepEqual(registered, [
      {
        name: "cliproxyapi",
        config: {
          models: [
            sol,
            ...["my-custom-model", "my-custom-model:fast"].map((id) => ({
              ...sol,
              id,
              name: id,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          ],
        },
      },
    ]);
  });

  it("leaves providers alone without a catalog or with nothing new in it", async () => {
    assert.deepEqual(await startSession({}, [sol, direct]), []);
    const known = JSON.stringify([{ url: "http://hub.test:8317", models: ["gpt-6.1-sol"] }]);
    assert.deepEqual(await startSession({ T3_HUB_MODELS: known }, [sol, direct]), []);
    assert.deepEqual(await startSession({ T3_HUB_MODELS: "not json" }, [sol, direct]), []);
  });
});
