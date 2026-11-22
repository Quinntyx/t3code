import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { use } from "react";

import { serverEnvironment } from "../../state/server";
import { OpenInPicker } from "./OpenInPicker";
import { TimelineRowCtx, type TimelineRowSharedState } from "./timelineRowContext";

export function ChangedFilesOpenIn() {
  const ctx = use(TimelineRowCtx) as TimelineRowSharedState | null;
  const environmentId = ctx?.activeThreadEnvironmentId ?? null;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (environmentId === null) return null;
  return (
    <OpenInPicker
      environmentId={environmentId}
      keybindings={config?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS}
      availableEditors={config?.availableEditors ?? []}
      openInCwd={ctx?.workspaceRoot ?? null}
      displayMode="card"
    />
  );
}
