import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { ImageSource } from "expo-image";

/**
 * Signed URLs change on each mint and reconnect, so the disk cache keys bytes by what
 * they are: immutable attachments and tool images by id, files by their revision.
 */
export function assetImageCacheKey(
  environmentId: EnvironmentId,
  resource: AssetResource,
  fileRevision?: string,
): string | undefined {
  switch (resource._tag) {
    case "attachment":
      return `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`;
    // Host media URLs name immutable uploads; the signed proxy URL around them does not.
    case SOURCE_CONTROL_MEDIA_ASSET:
      return `t3-host-media:${JSON.stringify([environmentId, resource.url])}`;
    case "tool-output-image":
      return `t3-tool-output:${JSON.stringify([environmentId, resource.threadId, resource.itemId, resource.index])}`;
    case "media-file":
    case "workspace-file":
      return fileRevision === undefined
        ? undefined
        : `t3-file:${JSON.stringify([environmentId, resource.threadId, resource.path, fileRevision])}`;
    default:
      return undefined;
  }
}

export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
  fileRevision?: string,
): ImageSource {
  const cacheKey = assetImageCacheKey(environmentId, resource, fileRevision);
  return cacheKey === undefined ? { uri } : { uri, cacheKey };
}
