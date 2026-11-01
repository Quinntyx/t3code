import { createDeusLocalAttachment, sameDeusScope } from "@t3tools/client-runtime/state/deus";
import type { DeusScope } from "@t3tools/contracts";
import { create } from "zustand";

export interface DeusVoiceControls {
  ready: boolean;
  active: boolean;
  muted: boolean;
  connect(): void;
  disconnect(): void;
  toggleMute(): void;
}
interface DeusPanelState {
  voice: { target: DeusScope; controls: DeusVoiceControls } | null;
  registerVoice(target: DeusScope, controls: DeusVoiceControls): void;
  unregisterVoice(target: DeusScope): void;
  target: DeusScope | null;
  pendingTarget: DeusScope | null;
  maximized: boolean;
  busy: boolean;
  error: string | null;
  localAttachment: ReturnType<typeof createDeusLocalAttachment>;
  requestOpen: (target: DeusScope) => void;
  cancelSwitch: () => void;
  confirmSwitch: () => Promise<void>;
  close: () => Promise<void>;
  releaseLocal: (target: DeusScope) => Promise<void>;
  setMaximized: (maximized: boolean) => void;
}

export function createDeusPanelStore() {
  return create<DeusPanelState>()((set, get) => {
    const localAttachment = createDeusLocalAttachment();
    const releaseLocal = async (target: DeusScope) => {
      try {
        await localAttachment.release(target);
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Could not release local Deus media.",
        });
        throw error;
      }
    };
    const transition = async (next: DeusScope | null) => {
      const { target, busy } = get();
      if (busy) return;
      set({ busy: true, error: null });
      try {
        if (target) await releaseLocal(target);
        set({ target: next, pendingTarget: null, maximized: false });
      } catch {
        // A failed local stop must not silently change the destination.
      } finally {
        set({ busy: false });
      }
    };
    return {
      target: null,
      voice: null,
      registerVoice: (target, controls) => set({ voice: { target, controls } }),
      unregisterVoice: (target) => {
        if (get().voice && sameDeusScope(get().voice!.target, target)) set({ voice: null });
      },
      pendingTarget: null,
      maximized: false,
      busy: false,
      error: null,
      localAttachment,
      releaseLocal,
      requestOpen: (target) => {
        const current = get();
        if (current.busy) return;
        if (current.target && sameDeusScope(current.target, target)) return;
        set(current.target ? { pendingTarget: target } : { target, error: null });
      },
      cancelSwitch: () => {
        if (!get().busy) set({ pendingTarget: null });
      },
      confirmSwitch: () => {
        const pending = get().pendingTarget;
        return pending ? transition(pending) : Promise.resolve();
      },
      close: () => transition(null),
      setMaximized: (maximized) => set({ maximized }),
    };
  });
}

export const useDeusPanelStore = createDeusPanelStore();
