import type { ModelSelection, ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface MachineHandoffRequest {
  readonly threadRef: ScopedThreadRef;
  readonly destination: ScopedProjectRef;
}

export interface MachineHandoffAttempt {
  readonly request: MachineHandoffRequest;
  readonly session: number;
  readonly retry: number;
  readonly status: "queued" | "running" | "failed";
  readonly selection: ModelSelection | null;
}

export const useMachineHandoffRequest = create<{
  requests: readonly MachineHandoffAttempt[];
  session: number;
}>(() => ({ requests: [], session: 0 }));

function activateNext(requests: readonly MachineHandoffAttempt[]) {
  if (requests.some((attempt) => attempt.status === "running")) return requests;
  const next = requests.find((attempt) => attempt.status === "queued");
  return next
    ? requests.map((attempt) =>
        attempt === next ? { ...attempt, status: "running" as const } : attempt,
      )
    : requests;
}

export function openMachineHandoff(request: MachineHandoffRequest) {
  useMachineHandoffRequest.setState((current) => {
    const previous = current.requests.find(
      (attempt) =>
        attempt.request.threadRef.environmentId === request.threadRef.environmentId &&
        attempt.request.threadRef.threadId === request.threadRef.threadId &&
        attempt.request.destination.environmentId === request.destination.environmentId &&
        attempt.request.destination.projectId === request.destination.projectId,
    );
    if (previous && previous.status !== "failed") return current;
    const attempt: MachineHandoffAttempt = previous
      ? { ...previous, retry: previous.retry + 1, status: "queued" }
      : {
          request,
          session: current.session + 1,
          retry: 0,
          status: "queued",
          selection: null,
        };
    return {
      session: Math.max(current.session, attempt.session),
      requests: activateNext([
        ...current.requests.filter((entry) => entry.session !== attempt.session),
        attempt,
      ]),
    };
  });
}

export function setMachineHandoffSelection(session: number, selection: ModelSelection) {
  useMachineHandoffRequest.setState((current) => ({
    requests: current.requests.map((attempt) =>
      attempt.session === session ? { ...attempt, selection } : attempt,
    ),
  }));
}

export function finishMachineHandoff(session: number, succeeded: boolean) {
  useMachineHandoffRequest.setState((current) => {
    const finished = current.requests.find((attempt) => attempt.session === session);
    if (finished?.status !== "running") return current;
    const requests = succeeded
      ? current.requests.filter((attempt) => attempt !== finished)
      : current.requests.map((attempt) =>
          attempt === finished ? { ...attempt, status: "failed" as const } : attempt,
        );
    return { requests: activateNext(requests) };
  });
}
