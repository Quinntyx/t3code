import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ComposerEffortColumn, describeComposerEffort } from "./ComposerModelEffort";
import type { TraitsSelectionInput } from "./TraitsPicker";

// Shaped like Devin over ACP: its session mode comes first, and its reasoning id is its own.
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "fusion",
    name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "mode",
          label: "Session Mode",
          type: "select",
          currentValue: "bypass",
          options: [
            { id: "code", label: "Code" },
            { id: "plan", label: "Plan" },
            { id: "bypass", label: "Bypass Permissions" },
          ],
        },
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    }),
  },
];

function traitsInput(
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
): TraitsSelectionInput {
  return {
    provider: ProviderDriverKind.make("acpRegistry"),
    instanceId: ProviderInstanceId.make("devin"),
    models,
    model: "fusion",
    modelOptions,
    onModelOptionsChange,
  };
}

function Column() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <>
      <div data-model-picker-effort>
        <ComposerEffortColumn traits={traits} />
      </div>
      <p role="status">{describeComposerEffort(traits, "bars", "sm").suffix}</p>
    </>
  );
}

it("draws an agent's reasoning as bars and keeps its mode out of the levels", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  const status = screen.getByRole("status");
  expect(status.element().querySelector("[data-composer-effort-glyph]")).not.toBeNull();
  await expect.element(status).toHaveTextContent("");

  const levels = screen.getByRole("radiogroup", { name: "Thinking" });
  await expect.element(levels.getByRole("radio")).toHaveLength(3);
  await expect.element(screen.getByRole("radio", { name: "Plan" })).not.toBeInTheDocument();

  // Up and Down walk from the levels through the option rows without opening their menus.
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  const speed = screen.getByRole("button", { name: "Speed: Standard" });
  await expect.element(speed).toHaveFocus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(speed).toHaveFocus();

  await userEvent.click(screen.getByText("Auto-approve tools"));
  await expect
    .element(screen.getByRole("switch", { name: "Auto-approve tools" }))
    .toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Session Mode: Bypass Permissions" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Plan" }));
  await expect
    .element(screen.getByRole("button", { name: "Session Mode: Plan" }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
});

const DEFAULT_LEVEL_INSTANCE = ProviderInstanceId.make("codex");
const DEFAULT_LEVEL_MODEL = "gpt-5.4";

function defaultLevelTraits(): TraitsSelectionInput {
  return {
    provider: ProviderDriverKind.make("codex"),
    instanceId: DEFAULT_LEVEL_INSTANCE,
    models: [
      {
        slug: DEFAULT_LEVEL_MODEL,
        name: DEFAULT_LEVEL_MODEL,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Thinking",
              type: "select",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
                { id: "max", label: "Max" },
              ],
            },
          ],
        }),
      },
    ],
    model: DEFAULT_LEVEL_MODEL,
    modelOptions: [{ id: "reasoningEffort", value: "high" }],
    threadRef: scopeThreadRef(
      EnvironmentId.make("environment-local"),
      ThreadId.make("thread-default-level"),
    ),
  };
}

function setupDefaultLevel(storedLevel?: string) {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  if (storedLevel === undefined) return;
  useComposerDraftStore.getState().setProviderModelOptionsDefault({
    provider: ProviderDriverKind.make("codex"),
    instanceId: DEFAULT_LEVEL_INSTANCE,
    model: DEFAULT_LEVEL_MODEL,
    options: [{ id: "reasoningEffort", value: storedLevel }],
  });
}

function storedDefaultLevel() {
  return useComposerDraftStore.getState().stickyOptionsByModelByProvider[DEFAULT_LEVEL_INSTANCE]?.[
    DEFAULT_LEVEL_MODEL
  ];
}

it("sets the effort level picked from the context menu as the model's default", async () => {
  setupDefaultLevel();
  await using screen = await render(<ComposerEffortColumn traits={defaultLevelTraits()} />, {
    router: false, // no routes involved
  });

  await userEvent.click(screen.getByRole("radio", { name: /^Low/ }), { button: "right" });
  await userEvent.click(page.getByRole("menuitem", { name: "Set Low as default" }));

  expect(storedDefaultLevel()).toEqual([{ id: "reasoningEffort", value: "low" }]);
  await expect.element(screen.getByRole("radio", { name: /Low\s*Default/ })).toBeVisible();
  await expect.element(screen.getByRole("radio", { name: "High", exact: true })).toBeVisible();
});

it("resets a model's default effort back to the provider's level", async () => {
  setupDefaultLevel("low");
  await using screen = await render(<ComposerEffortColumn traits={defaultLevelTraits()} />, {
    router: false, // no routes involved
  });

  await expect.element(screen.getByRole("radio", { name: /Low\s*Default/ })).toBeVisible();
  await userEvent.click(screen.getByRole("radio", { name: /^Low/ }), { button: "right" });
  await userEvent.click(page.getByRole("menuitem", { name: "Reset to provider default" }));

  expect(storedDefaultLevel()).toEqual([]);
  await expect.element(screen.getByRole("radio", { name: /High\s*Default/ })).toBeVisible();
});
