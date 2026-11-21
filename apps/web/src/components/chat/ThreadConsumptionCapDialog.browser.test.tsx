import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadConsumptionCap,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const save = vi.hoisted(() => vi.fn(async (_call: unknown) => ({ _tag: "Success" as const })));

vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => save) as never,
}));
vi.mock(
  import("../../state/threads"),
  () => ({ threadEnvironment: { updateMetadata: {} } }) as never,
);
vi.mock(import("../../hooks/useSettings"), () => ({
  usePrimarySettings: ((selector?: (settings: { timestampFormat: string }) => unknown) =>
    selector?.({ timestampFormat: "12-hour" })) as never,
}));

import { act, render } from "../../../test/render";
import {
  ThreadConsumptionCapDialog,
  type ThreadConsumptionCapRow,
} from "./ThreadConsumptionCapDialog";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const claude = ProviderInstanceId.make("claudeAgent");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");

const rows: ReadonlyArray<ThreadConsumptionCapRow> = [
  {
    key: `${claude}\u0000opus`,
    providerInstanceId: claude,
    driver: claudeDriver,
    model: "opus",
    label: "Opus",
    costUsd: 4,
    windows: [],
  },
  {
    key: `${codex}\u0000gpt`,
    providerInstanceId: codex,
    driver: codexDriver,
    model: "gpt-5.4",
    label: "GPT",
    costUsd: 2,
    windows: [],
  },
];

const renderDialog = (cap: ThreadConsumptionCap | null = null) =>
  render(
    <ThreadConsumptionCapDialog
      open
      onOpenChange={() => undefined}
      environmentId={environmentId}
      threadId={threadId}
      cap={cap}
      rows={rows}
    />,
  );

// Base UI's modal backdrop sits over the dialog in the test iframe, so these
// drive the dialog with the keyboard the way its Selects expect.
async function press(role: "button" | "combobox", name: string | RegExp) {
  const target = page.getByRole(role, { name });
  await act(() => target.element().focus());
  await userEvent.keyboard("{Enter}");
}

async function type(label: string, value: string) {
  const target = page.getByLabelText(label);
  await act(() => (target.element() as HTMLInputElement).focus());
  await userEvent.keyboard(value);
}

describe("ThreadConsumptionCapDialog", () => {
  it("saves a spend limit scoped to one model", async () => {
    save.mockClear();
    await using _screen = await renderDialog();

    await type("Limit 1 dollar cap", "12");
    await press("button", "Opus");
    await press("button", "Save");

    expect(save).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId,
        consumptionCap: {
          conditions: [
            {
              kind: "spend",
              limitUsd: 12,
              models: [{ providerInstanceId: claude, driver: claudeDriver, model: "opus" }],
            },
          ],
        },
      },
    });
  });

  it("saves independent spend and quota limits", async () => {
    save.mockClear();
    await using _screen = await renderDialog();

    await type("Limit 1 dollar cap", "20");
    await press("button", "Add limit");
    await press("combobox", "Limit 2 kind");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await type("Limit 2 usage percentage", "85");
    await press("button", "Save");

    expect(save).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId,
        consumptionCap: {
          conditions: [
            { kind: "spend", limitUsd: 20 },
            { kind: "quota", atPercent: 85, windowKind: "session", windowLabel: "5h" },
          ],
        },
      },
    });
  });

  it("keeps saved limits when the dialog reopens", async () => {
    save.mockClear();
    await using _screen = await renderDialog({
      conditions: [
        { kind: "spend", limitUsd: 20 },
        { kind: "quota", atPercent: 85, windowKind: "weekly" },
      ],
    });

    await expect.element(page.getByLabelText("Limit 1 dollar cap")).toHaveValue("20");
    await expect.element(page.getByLabelText("Limit 2 usage percentage")).toHaveValue("85");
    await press("button", "Save");

    expect(save.mock.calls[0]?.[0]).toMatchObject({
      input: {
        consumptionCap: {
          conditions: [
            { kind: "spend", limitUsd: 20 },
            { kind: "quota", atPercent: 85, windowKind: "weekly" },
          ],
        },
      },
    });
  });

  it("refuses to save a limit without a threshold", async () => {
    save.mockClear();
    await using _screen = await renderDialog();

    await press("button", "Save");

    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });
});
