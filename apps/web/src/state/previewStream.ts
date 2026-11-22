import { useAtomValue } from "@effect/atom-react";
import { PREVIEW_STREAM_BASE_PATH } from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

const ACCESS_RETRY_INTERVAL_MS = 10_000;

export interface PreviewStreamAccessState {
  readonly access: DeviceHubAccess | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

function formatAccessError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : m(msg("Could not connect to the remote browser."));
}

const previewStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: PREVIEW_STREAM_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`preview-stream-access:${environmentId}`)),
);

// Only a surface the user is looking at retries a failed lookup; one-shot readers such as
// picture-in-picture see the failure at once.
const retryingPreviewStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const access = previewStreamAccessAtom(environmentId);
    const result = get(access);
    if (AsyncResult.isFailure(result)) {
      const timer = setTimeout(() => get.refresh(access), ACCESS_RETRY_INTERVAL_MS);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }),
);

export function usePreviewStreamAccessState(
  environmentId: EnvironmentId,
  options?: { readonly retry: boolean },
): PreviewStreamAccessState {
  const result = useAtomValue(
    options?.retry
      ? retryingPreviewStreamAccessAtom(environmentId)
      : previewStreamAccessAtom(environmentId),
  );
  return {
    access: AsyncResult.isSuccess(result) ? result.value : null,
    error: AsyncResult.isFailure(result) ? formatAccessError(result.cause) : null,
    isPending: result.waiting,
  };
}

export function usePreviewStreamAccess(
  environmentId: EnvironmentId,
  options?: { readonly retry: boolean },
): DeviceHubAccess | null {
  return usePreviewStreamAccessState(environmentId, options).access;
}

export function refreshPreviewStreamAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(previewStreamAccessAtom(environmentId));
}

export function readPreviewStreamAccess(
  environmentId: EnvironmentId,
  refresh: boolean,
): Promise<DeviceHubAccess | null> {
  const atom = previewStreamAccessAtom(environmentId);
  if (refresh) appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
