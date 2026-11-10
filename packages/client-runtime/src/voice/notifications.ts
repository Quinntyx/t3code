import type { FunctionResponseScheduling } from "@google/genai";
import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";

export interface VoiceNotification {
  readonly id: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly message: string;
  readonly urgency: "interrupt" | "when_idle" | "silent";
}

export function notificationsFromShell(
  environmentId: string,
  snapshot: OrchestrationV2ShellSnapshot,
): ReadonlyArray<VoiceNotification> {
  const threads = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  return (snapshot.recentVoiceNotifications ?? []).flatMap(({ threadId, notification }) => {
    const thread = threads.get(threadId);
    return thread
      ? [
          {
            id: JSON.stringify([environmentId, threadId, notification.id]),
            environmentId,
            threadId,
            title: thread.title,
            message: notification.message,
            urgency: notification.urgency,
          },
        ]
      : [];
  });
}

export interface VoiceSeenStore {
  readonly has: (id: string) => boolean;
  readonly mark: (ids: ReadonlyArray<string>) => void;
}

export function notificationScheduling(
  urgency: VoiceNotification["urgency"],
): FunctionResponseScheduling {
  return (
    urgency === "interrupt" ? "INTERRUPT" : urgency === "silent" ? "SILENT" : "WHEN_IDLE"
  ) as FunctionResponseScheduling;
}

export function createNotificationFeed(
  seen: VoiceSeenStore,
  canSee: (notification: VoiceNotification) => boolean,
) {
  let visible: ReadonlyArray<VoiceNotification> = [];
  const listeners = new Set<() => void>();
  return {
    update(notifications: ReadonlyArray<VoiceNotification>) {
      visible = notifications;
      for (const listener of listeners) listener();
    },
    unseen: () =>
      visible.filter((notification) => canSee(notification) && !seen.has(notification.id)),
    mark: (notifications: ReadonlyArray<VoiceNotification>) =>
      seen.mark(notifications.map((notice) => notice.id)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type VoiceNotificationFeed = ReturnType<typeof createNotificationFeed>;
