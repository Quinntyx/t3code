import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { ChatAttachmentId, EnvironmentId } from "@t3tools/contracts";
import { Option } from "effect";

import { assetEnvironment } from "~/state/assets";
import { useEnvironmentQuery } from "~/state/query";
import { environmentSession } from "~/state/session";

/** Mints the signed asset URL a scratch attachment is served from. */
export function useScratchAttachmentUrl(
  environmentId: EnvironmentId,
  attachmentId: ChatAttachmentId | null,
): string | null {
  const atom =
    attachmentId === null
      ? null
      : assetEnvironment.createUrl({
          environmentId,
          input: { resource: { _tag: "attachment", attachmentId } },
        });
  const query = useEnvironmentQuery(atom);
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  if (query.data === null || Option.isNone(connection)) return null;
  return resolveAssetUrl(connection.value.httpBaseUrl, query.data.relativeUrl);
}
