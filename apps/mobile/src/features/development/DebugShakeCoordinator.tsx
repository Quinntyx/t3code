import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { StackActions } from "@react-navigation/native";
import { requireOptionalNativeModule } from "expo";
import { Accelerometer } from "expo-sensors";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { useAppActive } from "../../lib/appState";
import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  appendComposerDraftAttachments,
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { createShakeDetector } from "../devices/shakeDetector";
import { captureConsoleTail } from "./debug-shake-logs";

const native = requireOptionalNativeModule<{
  captureScreenshot(): Promise<string>;
}>("T3NativeControls");

async function openDebugShakeDraft(
  environmentId: string,
  projectId: string,
  tail: string,
  cancelled: () => boolean,
) {
  try {
    const uri = await native!.captureScreenshot();
    const attachments = await convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });
    if (attachments.length === 0) throw new Error("Could not attach the screenshot.");
    await waitForComposerDraftsLoaded();
    if (cancelled()) return;
    const draftKey = createNewTaskDraft({
      environmentId: EnvironmentId.make(environmentId),
      projectId: ProjectId.make(projectId),
    });
    setComposerDraftText(
      draftKey,
      `Describe the bug:\n\n\nT3 Code mobile logs (last 200 lines; long lines truncated):\n\n${tail || "No logs captured since debug shake was enabled."}`,
    );
    appendComposerDraftAttachments(draftKey, attachments);
    rootNavigationRef.dispatch(
      StackActions.push("Thread", { draft: { environmentId, projectId, draftId: draftKey } }),
    );
  } catch (error) {
    if (!cancelled()) {
      Dialog.alert(
        "Could not capture debug report",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  }
}

export function DebugShakeCoordinator() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.debugShakeEnabled === true;
  const target = AsyncResult.isSuccess(preferences)
    ? preferences.value.debugShakeProject
    : undefined;
  const environmentId = target?.environmentId;
  const projectId = target?.projectId;
  const active = useAppActive();
  const busy = useRef(false);
  const logs = useRef<ReturnType<typeof captureConsoleTail> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains a bounded console tail only while the user has opted into debug shake
  useEffect(() => {
    if (!enabled) return;
    const capture = captureConsoleTail();
    logs.current = capture;
    return () => {
      capture.dispose();
      logs.current = null;
    };
  }, [enabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the foreground accelerometer and releases it when disabled or backgrounded
  useEffect(() => {
    if (!enabled || !active || !environmentId || !projectId || !native?.captureScreenshot) return;
    let cancelled = false;
    const shaken = createShakeDetector({ cooldown: 3_000 });
    Accelerometer.setUpdateInterval(50);
    const subscription = Accelerometer.addListener((sample) => {
      if (
        !shaken({ ...sample, timestamp: sample.timestamp * 1000 }) ||
        busy.current ||
        !rootNavigationRef.isReady()
      )
        return;
      busy.current = true;
      void openDebugShakeDraft(
        environmentId,
        projectId,
        logs.current?.read() ?? "",
        () => cancelled,
      ).finally(() => {
        busy.current = false;
      });
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [enabled, active, environmentId, projectId]);

  return null;
}
