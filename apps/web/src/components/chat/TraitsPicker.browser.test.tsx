import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { TraitsPicker } from "./TraitsPicker";

const PROVIDER = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex");
const MODEL = "gpt-5.4";
const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-traits-default"),
);

const EFFORT_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Thinking",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
  currentValue: "high",
};

const MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MODEL,
    name: MODEL,
    isCustom: false,
    capabilities: { optionDescriptors: [EFFORT_DESCRIPTOR] },
  },
];

function selections(value: string): ReadonlyArray<ProviderOptionSelection> {
  return [{ id: "reasoningEffort", value }];
}

function setup() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function storedDefaultOptions() {
  return useComposerDraftStore.getState().stickyOptionsByModelByProvider[INSTANCE]?.[MODEL];
}

async function renderPicker() {
  return render(
    <TraitsPicker
      provider={PROVIDER}
      instanceId={INSTANCE}
      models={MODELS}
      model={MODEL}
      modelOptions={selections("high")}
      promptUltrathink="none"
      planModeEnabled={false}
      threadRef={THREAD_REF}
    />,
    { router: false },
  ); // the picker mounts no routes
}

it("sets the effort level picked from the context menu as the model's default", async () => {
  setup();
  await using screen = await renderPicker();

  await userEvent.click(screen.getByRole("button", { name: "High" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: /^Low/ }), { button: "right" });
  await userEvent.click(page.getByRole("menuitem", { name: "Set Low as default" }));

  expect(storedDefaultOptions()).toEqual(selections("low"));
  await expect.element(page.getByRole("menuitemradio", { name: /Low\s*Default/ })).toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: /^High/ })).toBeVisible();
});

it("resets a model default back to the provider's level", async () => {
  setup();
  useComposerDraftStore.getState().setProviderModelOptionsDefault({
    provider: PROVIDER,
    instanceId: INSTANCE,
    model: MODEL,
    options: [...selections("low")],
  });
  await using screen = await renderPicker();

  await userEvent.click(screen.getByRole("button", { name: "High" }));
  await expect.element(page.getByRole("menuitemradio", { name: /Low\s*Default/ })).toBeVisible();
  await userEvent.click(page.getByRole("menuitemradio", { name: /^Low/ }), { button: "right" });
  await expect
    .element(page.getByRole("menuitem", { name: "Reset to provider default" }))
    .toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Reset to provider default" }));

  expect(storedDefaultOptions()).toEqual([]);
  await expect.element(page.getByRole("menuitemradio", { name: /High\s*Default/ })).toBeVisible();
});
