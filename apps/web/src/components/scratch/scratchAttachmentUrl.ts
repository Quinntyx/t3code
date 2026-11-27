import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Option } from "effect";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { environmentSession } from "~/state/session";

/** Reads a scratch image as a URL outside React, for handing a file to the composer. */
export async function resolveScratchAttachmentUrl(
  environmentId: EnvironmentId,
  attachmentId: string,
): Promise<string | null> {
  const resource: AssetResource = { _tag: "attachment", attachmentId };
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({ environmentId, input: { resource } }),
    { label: "resolve scratch image", reportFailure: false },
  );
  if (result._tag !== "Success") return null;
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(connection)) return null;
  return resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
}
