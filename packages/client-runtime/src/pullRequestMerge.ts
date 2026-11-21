import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";

/** The repository's merge methods that the host currently allows for this change request. */
export function allowedPullRequestMergeMethods(
  detail: {
    readonly capabilities: Pick<PullRequestDetail["capabilities"], "mergeMethods">;
    readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
  } | null,
): ReadonlyArray<PullRequestMergeMethod> {
  return detail === null
    ? []
    : detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]);
}
