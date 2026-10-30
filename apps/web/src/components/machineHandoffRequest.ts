import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface MachineHandoffRequest {
  readonly threadRef: ScopedThreadRef;
  readonly destination?: ScopedProjectRef;
}

export const useMachineHandoffRequest = create<{
  request: MachineHandoffRequest | null;
  session: number;
}>(() => ({ request: null, session: 0 }));

export function openMachineHandoff(request: MachineHandoffRequest) {
  useMachineHandoffRequest.setState((state) => ({ request, session: state.session + 1 }));
}

export function closeMachineHandoff() {
  useMachineHandoffRequest.setState({ request: null });
}
