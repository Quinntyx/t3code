import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageWindow,
  ThreadConsumptionCap,
  ThreadConsumptionCapMode,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { type ReactNode, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface ThreadConsumptionCapRow {
  readonly key: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly costUsd: number | null;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}

interface RuleDraft {
  readonly limitUsd: string;
  readonly windowId: string;
  readonly atPercent: string;
}

const WINDOW_KIND_LABEL = {
  session: "5h",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Window",
} as const;

function windowLabel(window: ServerProviderUsageWindow): string {
  return window.label || WINDOW_KIND_LABEL[window.kind];
}

function parsePositive(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePercent(value: string): number | null {
  const parsed = parsePositive(value);
  return parsed !== null && parsed <= 100 ? parsed : null;
}

function initialDrafts(
  cap: ThreadConsumptionCap | null,
  rows: ReadonlyArray<ThreadConsumptionCapRow>,
): Record<string, RuleDraft> {
  return Object.fromEntries(
    rows.map((row) => {
      const rule = cap?.rules.find(
        (candidate) =>
          candidate.providerInstanceId === row.providerInstanceId && candidate.model === row.model,
      );
      return [
        row.key,
        {
          limitUsd: rule?.limitUsd?.toString() ?? "",
          windowId: rule?.windowId ?? row.windows[0]?.id ?? "",
          atPercent: rule?.atPercent?.toString() ?? "",
        } satisfies RuleDraft,
      ];
    }),
  );
}

function buildCap(
  mode: ThreadConsumptionCapMode,
  total: string,
  rows: ReadonlyArray<ThreadConsumptionCapRow>,
  drafts: Readonly<Record<string, RuleDraft>>,
  cap: ThreadConsumptionCap | null,
): { readonly cap: ThreadConsumptionCap | null; readonly error: string | null } {
  if (mode === "api") {
    const parsedTotal = total.trim().length === 0 ? undefined : parsePositive(total);
    if (total.trim().length > 0 && parsedTotal === null)
      return { cap: null, error: "Enter a positive total dollar cap." };
    const totalLimitUsd = parsedTotal ?? undefined;
    const rules = [];
    for (const row of rows) {
      const draft = drafts[row.key];
      const raw = draft?.limitUsd.trim() ?? "";
      if (raw.length === 0) continue;
      const limitUsd = parsePositive(raw);
      if (limitUsd === null)
        return { cap: null, error: `Enter a positive dollar cap for ${row.label}.` };
      rules.push({
        providerInstanceId: row.providerInstanceId,
        driver: row.driver,
        model: row.model,
        limitUsd,
      });
    }
    if (totalLimitUsd === undefined && rules.length === 0) return { cap: null, error: null };
    return {
      cap: {
        mode,
        ...(totalLimitUsd === undefined ? {} : { totalLimitUsd }),
        rules,
      },
      error: null,
    };
  }

  const rules = [];
  for (const row of rows) {
    const draft = drafts[row.key];
    const windowId = draft?.windowId ?? "";
    const raw = draft?.atPercent.trim() ?? "";
    if (windowId.length === 0 || raw.length === 0) continue;
    const atPercent = parsePercent(raw);
    if (atPercent === null)
      return { cap: null, error: `Enter a percentage from 1 to 100 for ${row.label}.` };
    const window = row.windows.find((candidate) => candidate.id === windowId);
    const stored = cap?.rules.find(
      (candidate) =>
        candidate.providerInstanceId === row.providerInstanceId && candidate.model === row.model,
    );
    const windowKind = window?.kind ?? stored?.windowKind;
    const label = window === undefined ? stored?.windowLabel : windowLabel(window);
    rules.push({
      providerInstanceId: row.providerInstanceId,
      driver: row.driver,
      model: row.model,
      windowId,
      ...(windowKind === undefined ? {} : { windowKind }),
      ...(label === undefined ? {} : { windowLabel: label }),
      atPercent,
    });
  }
  if (rules.length === 0) return { cap: null, error: null };
  return { cap: { mode, rules }, error: null };
}

export function ThreadConsumptionCapDialog({
  open,
  onOpenChange,
  environmentId,
  threadId,
  cap,
  rows,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cap: ThreadConsumptionCap | null;
  readonly rows: ReadonlyArray<ThreadConsumptionCapRow>;
}) {
  if (!open) return null;
  return (
    <ThreadConsumptionCapDialogContent
      onOpenChange={onOpenChange}
      environmentId={environmentId}
      threadId={threadId}
      cap={cap}
      rows={rows}
    />
  );
}

function ThreadConsumptionCapDialogContent({
  onOpenChange,
  environmentId,
  threadId,
  cap,
  rows,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cap: ThreadConsumptionCap | null;
  readonly rows: ReadonlyArray<ThreadConsumptionCapRow>;
}) {
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [mode, setMode] = useState<ThreadConsumptionCapMode>(cap?.mode ?? "api");
  const [total, setTotal] = useState(cap?.totalLimitUsd?.toString() ?? "");
  const [drafts, setDrafts] = useState(() => initialDrafts(cap, rows));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateDraft = (key: string, patch: Partial<RuleDraft>) => {
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? { limitUsd: "", windowId: "", atPercent: "" }), ...patch },
    }));
    setError(null);
  };

  const save = async (next: ThreadConsumptionCap | null) => {
    setSaving(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: { threadId, consumptionCap: next },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save the consumption cap.");
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const built = buildCap(mode, total, rows, drafts, cap);
            if (built.error !== null) {
              setError(built.error);
              return;
            }
            void save(built.cap);
          }}
        >
          <DialogHeader>
            <DialogTitle>Consumption cap</DialogTitle>
            <DialogDescription>
              Stop this thread when its API spend or a provider usage window reaches a limit.
              Delegated work counts toward the same thread.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label="Consumption cap mode"
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "api" || value === "quota") setMode(value);
                  setError(null);
                }}
              >
                <Toggle value="api">API spend</Toggle>
                <Toggle value="quota">Usage quota</Toggle>
              </ToggleGroup>

              {mode === "api" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="thread-consumption-total">Total cap</Label>
                  <Input
                    id="thread-consumption-total"
                    inputMode="decimal"
                    placeholder="No total cap"
                    value={total}
                    onChange={(event) => {
                      setTotal(event.target.value);
                      setError(null);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Priced API-list spend across every model in this thread. Models without a price
                    do not count.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Watch a provider usage window and stop the thread when it reaches the percentage.
                  The 5h session and weekly limits come from the Usage panel.
                </p>
              )}

              <div className="flex flex-col gap-2">
                {rows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    This thread has no model usage yet.
                  </p>
                ) : (
                  rows.map((row) => {
                    const draft = drafts[row.key] ?? {
                      limitUsd: "",
                      windowId: "",
                      atPercent: "",
                    };
                    const rule = cap?.rules.find(
                      (candidate) =>
                        candidate.providerInstanceId === row.providerInstanceId &&
                        candidate.model === row.model,
                    );
                    const selectedWindow = row.windows.find(
                      (candidate) => candidate.id === draft.windowId,
                    );
                    const windowOptions = [
                      ...row.windows.map((window) => ({
                        id: window.id,
                        label: windowLabel(window),
                        window,
                      })),
                      ...(draft.windowId.length > 0 && selectedWindow === undefined
                        ? [
                            {
                              id: draft.windowId,
                              label: rule?.windowLabel ?? "Saved window",
                              window: undefined,
                            },
                          ]
                        : []),
                    ];
                    const noWindows = windowOptions.length === 0;
                    const noPrice = row.costUsd === null;
                    return (
                      <div
                        key={row.key}
                        className="flex min-w-0 flex-col gap-2 rounded-md border border-border/70 p-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {row.icon}
                          <span className="min-w-0 flex-1 truncate text-sm">{row.label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {row.costUsd === null ? "No price data" : formatUsd(row.costUsd)}
                          </span>
                        </div>
                        {mode === "api" ? (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-xs text-muted-foreground">Cap</span>
                            <Input
                              aria-label={`${row.label} dollar cap`}
                              inputMode="decimal"
                              className="h-8"
                              placeholder="No cap"
                              disabled={noPrice}
                              value={draft.limitUsd}
                              onChange={(event) =>
                                updateDraft(row.key, { limitUsd: event.target.value })
                              }
                            />
                          </div>
                        ) : (
                          <div className="flex min-w-0 items-center gap-2">
                            <Select
                              value={draft.windowId}
                              items={Object.fromEntries(
                                windowOptions.map((option) => [option.id, option.label]),
                              )}
                              onValueChange={(value) => {
                                if (typeof value === "string")
                                  updateDraft(row.key, { windowId: value });
                              }}
                            >
                              <SelectTrigger className="h-8 min-w-0 flex-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectPopup>
                                {windowOptions.map((option) => (
                                  <SelectItem key={option.id} value={option.id}>
                                    {option.window === undefined
                                      ? `${option.label} · usage data unavailable`
                                      : `${option.label} · ${Math.round(option.window.usedPercent)}% used`}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                            <div className="flex shrink-0 items-center gap-1">
                              <Input
                                inputMode="decimal"
                                className="h-8 w-16"
                                placeholder="80"
                                aria-label={`${row.label} cap percentage`}
                                disabled={noWindows}
                                value={draft.atPercent}
                                onChange={(event) =>
                                  updateDraft(row.key, { atPercent: event.target.value })
                                }
                              />
                              <span className="text-xs text-muted-foreground">%</span>
                            </div>
                          </div>
                        )}
                        {mode === "quota" ? (
                          <p className="text-xs text-muted-foreground">
                            {noWindows
                              ? "No 5h or weekly usage is reported for this account."
                              : draft.windowId.length === 0
                                ? "Pick a usage window."
                                : selectedWindow === undefined
                                  ? "Usage data for this window is unavailable."
                                  : `${Math.round(selectedWindow.usedPercent)}% used${
                                      selectedWindow.resetsAt
                                        ? ` · resets ${formatUpcomingTimestamp(selectedWindow.resetsAt, timestampFormat)}`
                                        : ""
                                    }`}
                          </p>
                        ) : noPrice ? (
                          <p className="text-xs text-muted-foreground">
                            No API price is known for this model, so a dollar cap cannot be
                            enforced.
                          </p>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
              {error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost-muted"
              className="sm:mr-auto"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Remove cap
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
