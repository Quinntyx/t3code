import { useSyncExternalStore } from "react";
import type { DeusScope } from "@t3tools/contracts";
import { createDeusLocalAttachment, sameDeusScope } from "@t3tools/client-runtime/state/deus";

export interface DeusVoiceControls {
  ready: boolean;
  active: boolean;
  muted: boolean;
  connect(): void;
  disconnect(): void;
  toggleMute(): void;
}
interface PanelState {
  voice: { target: DeusScope; controls: DeusVoiceControls } | null;
  registerVoice(target: DeusScope, controls: DeusVoiceControls): void;
  unregisterVoice(target: DeusScope): void;
  visible: boolean;
  choosing: boolean;
  target: DeusScope | null;
  pendingTarget: DeusScope | null;
  busy: boolean;
  error: string | null;
  localAttachment: ReturnType<typeof createDeusLocalAttachment>;
  openPicker(): void;
  select(target: DeusScope): void;
  cancelSwitch(): void;
  confirmSwitch(): Promise<void>;
  close(): Promise<void>;
  visitWorker(): Promise<boolean>;
}
export function createDeusPanelStore() {
  const listeners = new Set<() => void>();
  const get = () => state;
  const set = (patch: Partial<PanelState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let state: PanelState = {
    voice: null,
    registerVoice: (target, controls) => set({ voice: { target, controls } }),
    unregisterVoice: (target) => {
      if (get().voice && sameDeusScope(get().voice!.target, target)) set({ voice: null });
    },
    visible: false,
    choosing: false,
    target: null,
    pendingTarget: null,
    busy: false,
    error: null,
    localAttachment: createDeusLocalAttachment(),
    openPicker: () => {
      if (!get().busy) set({ visible: true, choosing: true, error: null });
    },
    select: (target) => {
      if (get().busy) return;
      const current = get().target;
      if (current && !sameDeusScope(current, target)) set({ pendingTarget: target });
      else set({ target: current ?? target, visible: true, choosing: false, pendingTarget: null });
    },
    cancelSwitch: () => {
      if (!get().busy) set({ pendingTarget: null, choosing: !get().target });
    },
    confirmSwitch: async () => {
      const { target, pendingTarget, localAttachment, busy } = get();
      if (!target || !pendingTarget || busy) return;
      set({ busy: true, error: null });
      try {
        await localAttachment.release(target);
        set({ target: pendingTarget, pendingTarget: null, choosing: false });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Local voice cleanup failed." });
      } finally {
        set({ busy: false });
      }
    },
    visitWorker: async () => {
      const { target, localAttachment, busy } = get();
      if (!target || busy) return false;
      set({ busy: true, error: null });
      try {
        await localAttachment.release(target);
        set({ visible: false, choosing: false });
        return true;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Local voice cleanup failed." });
        return false;
      } finally {
        set({ busy: false });
      }
    },
    close: async () => {
      const { target, localAttachment, busy } = get();
      if (busy) return;
      set({ busy: true, error: null });
      try {
        if (target) await localAttachment.release(target);
        set({ visible: false, choosing: false, target: null, pendingTarget: null });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Local voice cleanup failed." });
      } finally {
        set({ busy: false });
      }
    },
  };
  return {
    getState: get,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
const panelStore = createDeusPanelStore();
export const useDeusPanelStore = Object.assign(
  () => useSyncExternalStore(panelStore.subscribe, panelStore.getState),
  panelStore,
);
