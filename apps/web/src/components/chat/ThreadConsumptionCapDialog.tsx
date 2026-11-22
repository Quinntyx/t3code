import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageWindow,
  ThreadConsumptionCap,
  ThreadConsumptionCapCondition,
  ThreadConsumptionCapWindowKind,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useMessages } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { m, type MessageResolver } from "../../i18n/messages";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface ThreadConsumptionCapRow {
  readonly key: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly label: string;
  readonly costUsd: number | null;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}

interface ConditionDraft {
  /** Local identity for the editor; conditions themselves carry no id. */
  readonly key: string;
  readonly kind: ThreadConsumptionCapCondition["kind"];
  /** `all` watches every model; otherwise the row keys this condition covers. */
  readonly scope: "all" | ReadonlyArray<string>;
  readonly limitUsd: string;
  readonly atPercent: string;
  readonly windowKind: ThreadConsumptionCapWindowKind;
}

const WINDOW_KINDS: ReadonlyArray<ThreadConsumptionCapWindowKind> = [
  "session",
  "weekly",
  "monthly",
  "other",
];

const WINDOW_KIND_WIRE_LABEL = {
  session: "5h",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Window",
} as const;

const WINDOW_KIND_LABEL = {
  session: msg("5h"),
  weekly: msg("Weekly"),
  monthly: msg("Monthly"),
  other: msg("Window"),
} as const;

const KIND_LABEL = {
  spend: msg("API spend"),
  quota: msg("Usage quota"),
} as const;

function windowWireLabel(window: ServerProviderUsageWindow): string {
  return window.label || WINDOW_KIND_WIRE_LABEL[window.kind];
}

function windowDisplayLabel(window: ServerProviderUsageWindow, resolve: MessageResolver): string {
  return window.label || resolve(WINDOW_KIND_LABEL[window.kind]);
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

const rowKey = (model: { providerInstanceId: ProviderInstanceId; model: string }) =>
  `${model.providerInstanceId}\u0000${model.model}`;

function scopedRows(
  rows: ReadonlyArray<ThreadConsumptionCapRow>,
  scope: ConditionDraft["scope"],
): ReadonlyArray<ThreadConsumptionCapRow> {
  return scope === "all" ? rows : rows.filter((row) => scope.includes(row.key));
}

/** The worst window of each kind the condition's models report. */
function windowChoices(
  rows: ReadonlyArray<ThreadConsumptionCapRow>,
  scope: ConditionDraft["scope"],
  resolve: MessageResolver = m,
) {
  const scoped = scopedRows(rows, scope);
  return WINDOW_KINDS.map((kind) => {
    const windows = scoped.flatMap((row) => row.windows.filter((window) => window.kind === kind));
    if (windows.length === 0) {
      return {
        kind,
        label: resolve(WINDOW_KIND_LABEL[kind]),
        wireLabel: WINDOW_KIND_WIRE_LABEL[kind],
        window: null as ServerProviderUsageWindow | null,
      };
    }
    const worst = windows.reduce((left, right) =>
      right.usedPercent > left.usedPercent ? right : left,
    );
    return {
      kind,
      label: windowDisplayLabel(worst, resolve),
      wireLabel: windowWireLabel(worst),
      window: worst,
    };
  });
}

function newDraft(kind: ThreadConsumptionCapCondition["kind"], key: string): ConditionDraft {
  return {
    key,
    kind,
    scope: "all",
    limitUsd: "",
    atPercent: "",
    windowKind: "session",
  };
}

function initialDrafts(cap: ThreadConsumptionCap | null): ReadonlyArray<ConditionDraft> {
  if (cap === null || cap.conditions.length === 0) return [newDraft("spend", "draft-0")];
  return cap.conditions.map((condition, index) => ({
    key: `draft-${index}`,
    kind: condition.kind,
    scope: condition.models === undefined ? "all" : condition.models.map((model) => rowKey(model)),
    limitUsd: condition.kind === "spend" ? condition.limitUsd.toString() : "",
    atPercent: condition.kind === "quota" ? condition.atPercent.toString() : "",
    windowKind: condition.kind === "quota" ? condition.windowKind : "session",
  }));
}

function buildCap(
  drafts: ReadonlyArray<ConditionDraft>,
  rows: ReadonlyArray<ThreadConsumptionCapRow>,
  resolve: MessageResolver = m,
): { readonly cap: ThreadConsumptionCap | null; readonly error: string | null } {
  const conditions: Array<ThreadConsumptionCapCondition> = [];
  for (const draft of drafts) {
    const models =
      draft.scope === "all"
        ? undefined
        : scopedRows(rows, draft.scope).map((row) => ({
            providerInstanceId: row.providerInstanceId,
            driver: row.driver,
            model: row.model,
          }));
    if (models !== undefined && models.length === 0) {
      return {
        cap: null,
        error: resolve(msg("Pick at least one model, or All, for every limit.")),
      };
    }
    if (draft.kind === "spend") {
      const limitUsd = parsePositive(draft.limitUsd);
      if (limitUsd === null) {
        return {
          cap: null,
          error: resolve(msg("Enter a positive dollar amount for every API spend limit.")),
        };
      }
      conditions.push({
        kind: "spend",
        limitUsd,
        ...(models === undefined ? {} : { models }),
      });
      continue;
    }
    const atPercent = parsePercent(draft.atPercent);
    if (atPercent === null) {
      return {
        cap: null,
        error: resolve(msg("Enter a percentage from 1 to 100 for every usage quota limit.")),
      };
    }
    const choice = windowChoices(rows, draft.scope, resolve).find(
      (candidate) => candidate.kind === draft.windowKind,
    );
    conditions.push({
      kind: "quota",
      atPercent,
      windowKind: draft.windowKind,
      ...(choice === undefined ? {} : { windowLabel: choice.wireLabel }),
      ...(models === undefined ? {} : { models }),
    });
  }
  return { cap: conditions.length === 0 ? null : { conditions }, error: null };
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
  const gt = useGT();
  const resolve = useMessages();
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const nextKeyRef = useRef(cap?.conditions.length ?? 0);
  const [drafts, setDrafts] = useState(() => initialDrafts(cap));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const kindLabels = {
    spend: resolve(KIND_LABEL.spend),
    quota: resolve(KIND_LABEL.quota),
  };

  const updateDraft = (key: string, patch: Partial<ConditionDraft>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
    setError(null);
  };

  const updateScope = (key: string, values: ReadonlyArray<string>) => {
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.key !== key) return draft;
        const previous = draft.scope === "all" ? ["all"] : draft.scope;
        const added = values.find((value) => !previous.includes(value));
        if (added === "all") return { ...draft, scope: "all" };
        if (added !== undefined) {
          return { ...draft, scope: values.filter((value) => value !== "all") };
        }
        const remaining = values.filter((value) => value !== "all");
        return { ...draft, scope: remaining.length === 0 ? "all" : remaining };
      }),
    );
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
      setError(cause instanceof Error ? cause.message : gt("Could not save the consumption cap."));
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
            const built = buildCap(drafts, rows, resolve);
            if (built.error !== null) {
              setError(built.error);
              return;
            }
            void save(built.cap);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Consumption cap</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Stop this thread when any one of these limits is reached. Delegated work counts
                toward the same thread.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                {drafts.map((draft, index) => {
                  const choices = windowChoices(rows, draft.scope, resolve);
                  const selected = choices.find((choice) => choice.kind === draft.windowKind);
                  const scoped = scopedRows(rows, draft.scope);
                  const unpriced =
                    draft.kind === "spend" &&
                    scoped.some((row) => row.costUsd === null) &&
                    scoped.some((row) => row.costUsd !== null);
                  return (
                    <div
                      key={draft.key}
                      className="flex min-w-0 flex-col gap-2 rounded-md border border-border/70 p-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Select
                          value={draft.kind}
                          items={kindLabels}
                          onValueChange={(value) => {
                            if (value === "spend" || value === "quota") {
                              updateDraft(draft.key, { kind: value });
                            }
                          }}
                        >
                          <SelectTrigger
                            aria-label={gt("Limit {index} kind", { index: index + 1 })}
                            className="h-8 min-w-0 flex-1"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="spend">{kindLabels.spend}</SelectItem>
                            <SelectItem value="quota">{kindLabels.quota}</SelectItem>
                          </SelectPopup>
                        </Select>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={gt("Remove limit {index}", { index: index + 1 })}
                          onClick={() => {
                            setDrafts((current) =>
                              current.filter((candidate) => candidate.key !== draft.key),
                            );
                            setError(null);
                          }}
                        >
                          <XIcon aria-hidden />
                        </Button>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          <T>Models</T>
                        </span>
                        <ToggleGroup
                          aria-label={gt("Models this limit watches")}
                          multiple
                          variant="segmented"
                          value={draft.scope === "all" ? ["all"] : draft.scope}
                          onValueChange={(values) => updateScope(draft.key, values)}
                        >
                          <Toggle value="all">
                            <T>All</T>
                          </Toggle>
                          {rows.map((row) => (
                            <Toggle key={row.key} value={row.key}>
                              {row.label}
                            </Toggle>
                          ))}
                        </ToggleGroup>
                      </div>

                      {draft.kind === "spend" ? (
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-xs text-muted-foreground">
                            <T>Stop at</T>
                          </span>
                          <Input
                            aria-label={gt("Limit {index} dollar cap", { index: index + 1 })}
                            inputMode="decimal"
                            className="h-8"
                            placeholder="10.00"
                            value={draft.limitUsd}
                            onChange={(event) =>
                              updateDraft(draft.key, { limitUsd: event.target.value })
                            }
                          />
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-center gap-2">
                          <Input
                            aria-label={gt("Limit {index} usage percentage", { index: index + 1 })}
                            inputMode="decimal"
                            className="h-8 w-16"
                            placeholder="80"
                            value={draft.atPercent}
                            onChange={(event) =>
                              updateDraft(draft.key, { atPercent: event.target.value })
                            }
                          />
                          <span className="shrink-0 text-xs text-muted-foreground">
                            <T>% of</T>
                          </span>
                          <Select
                            value={draft.windowKind}
                            items={Object.fromEntries(
                              choices.map((choice) => [choice.kind, choice.label]),
                            )}
                            onValueChange={(value) => {
                              if (value !== null && WINDOW_KINDS.some((kind) => kind === value)) {
                                updateDraft(draft.key, {
                                  windowKind: value as ThreadConsumptionCapWindowKind,
                                });
                              }
                            }}
                          >
                            <SelectTrigger className="h-8 min-w-0 flex-1">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {choices.map((choice) => (
                                <SelectItem key={choice.kind} value={choice.kind}>
                                  {choice.window === null
                                    ? gt("{label} · usage data unavailable", {
                                        label: choice.label,
                                      })
                                    : gt("{label} · {percent}% used", {
                                        label: choice.label,
                                        percent: Math.round(choice.window.usedPercent),
                                      })}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </div>
                      )}

                      {draft.kind === "quota" ? (
                        <p className="text-xs text-muted-foreground">
                          {selected?.window === null || selected === undefined
                            ? gt("This account does not report that window yet.")
                            : selected.window.resetsAt
                              ? gt("{percent}% used · resets {resetsAt}", {
                                  percent: Math.round(selected.window.usedPercent),
                                  resetsAt: formatUpcomingTimestamp(
                                    selected.window.resetsAt,
                                    timestampFormat,
                                    undefined,
                                    undefined,
                                    resolve,
                                  ),
                                })
                              : gt("{percent}% used", {
                                  percent: Math.round(selected.window.usedPercent),
                                })}
                        </p>
                      ) : unpriced ? (
                        <p className="text-xs text-muted-foreground">
                          <T>
                            Models without a known API price do not count, so the total is a floor.
                          </T>
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() => {
                  setDrafts((current) => [
                    ...current,
                    newDraft("spend", `draft-${(nextKeyRef.current += 1)}`),
                  ]);
                  setError(null);
                }}
              >
                <PlusIcon aria-hidden />
                <T>Add limit</T>
              </Button>

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
              <T>Remove cap</T>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? gt("Saving…") : gt("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
