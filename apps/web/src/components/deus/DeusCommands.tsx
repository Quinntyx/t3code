import { useAtomValue } from "@effect/atom-react";
import { sameDeusScope } from "@t3tools/client-runtime/state/deus";
import { EnvironmentId, ProjectId, type DeusScope } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useDeusPanelStore } from "../../deusPanelStore";
import { resolveShortcutCommand } from "../../keybindings";
import { deusEnvironment } from "../../state/deus";
import { useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";

export function useDeusCommands(target: DeusScope | null) {
  const navigate = useNavigate();
  const voice = useDeusPanelStore((state) => state.voice);
  const environmentId = target?.environmentId ?? null;
  const canOpen = useAtomValue(deusEnvironment.open.permissionAtom(environmentId));
  const canRead = useAtomValue(deusEnvironment.getSnapshot.permissionAtom(environmentId));
  const canAttach = useAtomValue(deusEnvironment.attach.permissionAtom(environmentId));
  const canControl = useAtomValue(deusEnvironment.mediaControl.permissionAtom(environmentId));
  const controls = target && voice && sameDeusScope(voice.target, target) ? voice.controls : null;
  return [
    {
      command: "deus.open" as const,
      title: "Open or focus Deus",
      enabled: !!target && canOpen && canRead,
      run: () => {
        if (!target || !canOpen || !canRead) return;
        useDeusPanelStore.getState().requestOpen(target);
        void navigate({ to: "/projects/$environmentId/$projectId", params: target });
      },
    },
    {
      command: "deus.connect" as const,
      title: "Connect Deus voice",
      enabled: !!controls?.ready && !controls.active && canAttach,
      run: () => {
        if (canAttach && controls?.ready && !controls.active) controls.connect();
      },
    },
    {
      command: "deus.disconnect" as const,
      title: "Disconnect Deus voice",
      enabled: !!controls?.active,
      run: () => controls?.disconnect(),
    },
    {
      command: "deus.mute" as const,
      title: controls?.muted ? "Resume Deus microphone" : "Mute Deus microphone",
      enabled: !!controls?.active && canControl,
      run: () => {
        if (canControl && controls?.active) controls.toggleMute();
      },
    },
  ];
}
export function DeusShortcuts() {
  const params = useParams({ strict: false });
  const threads = useThreadShells();
  const pinned = useDeusPanelStore((state) => state.target);
  const thread = threads.find(
    (item) => item.environmentId === params.environmentId && item.id === params.threadId,
  );
  const target = thread
    ? { environmentId: thread.environmentId, projectId: thread.projectId }
    : params.environmentId && params.projectId
      ? {
          environmentId: EnvironmentId.make(params.environmentId),
          projectId: ProjectId.make(params.projectId),
        }
      : pinned;
  const commands = useDeusCommands(target);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // oxlint-disable-next-line t3code/react-effect-budget -- The shell owns keyboard listeners for the shared Deus entry commands.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: event.target instanceof HTMLElement && !!event.target.closest(".xterm"),
        },
      });
      const action = commands.find((item) => item.command === command);
      if (!action?.enabled) return;
      event.preventDefault();
      action.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commands, keybindings]);
  return null;
}
