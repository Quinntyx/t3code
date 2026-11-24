import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ChatAttachmentId, EnvironmentId, ScratchKey } from "@t3tools/contracts";
import { Option } from "effect";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { scratchEnvironment } from "~/state/scratch";

export interface UploadedScratchImage {
  readonly attachmentId: ChatAttachmentId;
  readonly name: string;
}

async function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

export function useScratchImageUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly scratchKey: ScratchKey;
}) {
  const { environmentId, scratchKey } = input;
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));

  return async (files: ReadonlyArray<File>): Promise<ReadonlyArray<UploadedScratchImage>> => {
    if (Option.isNone(connection)) return [];
    const uploaded: UploadedScratchImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const size = await readImageSize(file);
      const result = await runAtomCommand(
        appAtomRegistry,
        scratchEnvironment.createImageUploadUrl,
        {
          environmentId,
          input: {
            scratchKey,
            name: file.name || "image",
            mimeType: file.type,
            sizeBytes: file.size,
            ...(size === null ? {} : { width: size.width, height: size.height }),
          },
        },
        { label: "create scratch image upload", reportFailure: false },
      );
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: m(msg("Could not add the image")),
          description: failure instanceof Error ? failure.message : undefined,
        });
        continue;
      }
      const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
      if (url === null) continue;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      }).catch(() => null);
      if (response === null || !response.ok) {
        toastManager.add({
          type: "error",
          title: m(msg("Could not add the image")),
        });
        continue;
      }
      uploaded.push({ attachmentId: result.value.attachmentId, name: file.name });
    }
    return uploaded;
  };
}
