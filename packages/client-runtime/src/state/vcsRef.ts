import { resolveDefaultRefRemote } from "@t3tools/shared/git";
import type { EnvironmentId, VcsListRefsInput, VcsRef as ContractVcsRef } from "@t3tools/contracts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
  /** Lists only this remote's remote refs. */
  readonly remoteName?: string | null;
  /** Lists every remote ref, including ones a local branch already tracks. */
  readonly remoteRefsOnly?: boolean;
}

export type VcsRef = ContractVcsRef;

/** The listRefs input fields a target adds beyond cwd, query, and paging. */
export function vcsRefTargetListInput(
  target: Pick<VcsRefTarget, "remoteName" | "remoteRefsOnly">,
): Pick<VcsListRefsInput, "remoteName" | "refKind" | "includeMatchingRemoteRefs"> {
  return {
    ...(target.remoteName ? { remoteName: target.remoteName } : {}),
    ...(target.remoteRefsOnly
      ? { refKind: "remote" as const, includeMatchingRemoteRefs: true }
      : {}),
  };
}

/** Branch pickers list the default remote first; other remotes are a second tier. */
export type BranchPickerRemoteView =
  | { readonly kind: "default" }
  | { readonly kind: "remotes" }
  | { readonly kind: "remote"; readonly remoteName: string };

export interface BranchPickerRemotes {
  readonly view: BranchPickerRemoteView;
  readonly otherRemoteNames: ReadonlyArray<string>;
  readonly onViewChange: (view: BranchPickerRemoteView) => void;
  readonly onOpenOtherRemotes: () => void;
}

export function branchPickerRemotes(input: {
  readonly view: BranchPickerRemoteView;
  readonly onViewChange: (view: BranchPickerRemoteView) => void;
  readonly remoteNames: ReadonlyArray<string> | undefined;
  readonly preferredRemoteName: string;
}): BranchPickerRemotes {
  const otherRemoteNames = otherBranchRemoteNames(input.remoteNames, input.preferredRemoteName);
  return {
    view: input.view,
    otherRemoteNames,
    onViewChange: input.onViewChange,
    onOpenOtherRemotes: () => input.onViewChange(otherRemotesView(otherRemoteNames)),
  };
}

export function branchPickerRefTarget(
  view: BranchPickerRemoteView,
  preferredRemoteName: string,
): Pick<VcsRefTarget, "remoteName" | "remoteRefsOnly"> {
  return view.kind === "remote"
    ? { remoteName: view.remoteName, remoteRefsOnly: true }
    : { remoteName: preferredRemoteName || "origin", remoteRefsOnly: false };
}

function otherBranchRemoteNames(
  remoteNames: ReadonlyArray<string> | undefined,
  preferredRemoteName: string,
): ReadonlyArray<string> {
  const defaultRemoteName = resolveDefaultRefRemote(remoteNames ?? [], preferredRemoteName);
  return (remoteNames ?? []).filter((name) => name !== defaultRemoteName);
}

/** Where "Other remotes" leads; a single other remote skips the remote list. */
function otherRemotesView(otherRemoteNames: ReadonlyArray<string>): BranchPickerRemoteView {
  const [onlyRemoteName, ...rest] = otherRemoteNames;
  return onlyRemoteName !== undefined && rest.length === 0
    ? { kind: "remote", remoteName: onlyRemoteName }
    : { kind: "remotes" };
}

export function parentBranchPickerRemoteView(
  view: BranchPickerRemoteView,
  otherRemoteNames: ReadonlyArray<string>,
): BranchPickerRemoteView {
  return view.kind === "remote" && otherRemoteNames.length > 1
    ? { kind: "remotes" }
    : { kind: "default" };
}

/** A remote ref's branch name within its remote, for lists already grouped by remote. */
export function branchNameWithinRemote(ref: Pick<VcsRef, "name" | "remoteName">): string {
  return ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)
    ? ref.name.slice(ref.remoteName.length + 1)
    : ref.name;
}
