import {
  CommandId,
  GitRestackError,
  MessageId,
  PullRequestOperationError,
  type GitRestackHandoffReason,
  type GitRestackThreadResult,
  type GitRestackThreadsInput,
  type GitRestackThreadsResult,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type PullRequestMergeStackInput,
  type PullRequestMergeStackResult,
  type PullRequestSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { busyThreadsInCheckout, resolveSharedCheckoutScope } from "../git/sharedCheckoutGuard.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PullRequestService from "./PullRequestService.ts";

interface StackMergeReport {
  /** Open pull requests now based on the merged pull request's base. */
  readonly retargeted: ReadonlyArray<number>;
  /** Open pull requests still based on the merged branch because the host refused. */
  readonly failed: ReadonlyArray<number>;
  readonly restacks: ReadonlyArray<GitRestackThreadResult>;
}

export interface PullRequestStackMergeOptions extends PullRequestMergeStackInput {
  /** Pin the target PR's head commit before merging (used by MCP callers). */
  readonly expectedHeadSha?: string | undefined;
  /** Refuse when the PR is not in any multi-layer stack (native or derived). */
  readonly requireMultiLayer?: boolean | undefined;
}

export class PullRequestStackService extends Context.Service<
  PullRequestStackService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Points the open pull requests based on a merged branch, and the threads that own them, at
     * the merged pull request's base. Runs once per merge however many callers ask.
     */
    readonly afterMerge: (
      merged: PullRequestService.PullRequestMergeEvent,
    ) => Effect.Effect<StackMergeReport>;
    readonly restackDependents: (
      input: GitRestackThreadsInput,
    ) => Effect.Effect<GitRestackThreadsResult, GitRestackError>;
    readonly mergeStack: (
      input: PullRequestStackMergeOptions,
    ) => Effect.Effect<PullRequestMergeStackResult, PullRequestService.PullRequestError>;
  }
>()("t3/pullRequest/PullRequestStackService") {}

/** Pin every unmerged layer up to `number` and merge through the host's native stack action. */
export const mergeNativeStack = Effect.fn("PullRequestStackService.mergeNativeStack")(function* (
  pullRequests: Pick<PullRequestService.PullRequestService["Service"], "stack" | "runAction">,
  input: PullRequestStackMergeOptions,
  preloadedStack?: Effect.Success<
    ReturnType<PullRequestService.PullRequestService["Service"]["stack"]>
  >,
): Effect.fn.Return<PullRequestMergeStackResult, PullRequestService.PullRequestError> {
  const ref = {
    projectId: input.projectId,
    repository: input.repository,
    ...(input.host === undefined ? {} : { host: input.host }),
    number: input.number,
  };
  const nativeStack =
    preloadedStack !== undefined
      ? preloadedStack
      : yield* pullRequests.stack(ref, { bypassCache: true });
  const end = nativeStack?.layers.findIndex((layer) => layer.number === input.number) ?? -1;
  if (
    nativeStack === null ||
    end === -1 ||
    (input.requireMultiLayer === true && nativeStack.layers.length <= 1)
  ) {
    return yield* new PullRequestOperationError({
      operation: "mergeStack",
      detail: `PR #${input.number} is not in a stack this host can merge. Merge it without stack.`,
    });
  }
  const expectedStackHeads: Array<{ readonly number: number; readonly headSha: string }> = [];
  for (const layer of nativeStack.layers.slice(0, end + 1)) {
    if (layer.state === "merged") continue;
    const headSha =
      layer.number !== input.number
        ? layer.headSha
        : input.expectedHeadSha === undefined
          ? layer.headSha
          : layer.headSha !== undefined &&
              PullRequestService.isHeadSha(layer.headSha, input.expectedHeadSha)
            ? layer.headSha
            : input.expectedHeadSha;
    if (headSha === undefined) {
      return yield* new PullRequestOperationError({
        operation: "mergeStack",
        detail: `The host did not report PR #${layer.number}'s head, so the stack cannot be pinned. Try again.`,
      });
    }
    expectedStackHeads.push({ number: layer.number, headSha });
  }
  yield* pullRequests.runAction({
    ...ref,
    action: "merge",
    stackNumber: nativeStack.number,
    expectedStackHeads,
    ...(input.expectedHeadSha === undefined ? {} : { expectedHeadSha: input.expectedHeadSha }),
    ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
  });
  return { merged: expectedStackHeads.map((layer) => layer.number) };
});

const sameRepository = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** The open pull request opened from the thread's own branch. */
function ownOpenPullRequest(
  thread: Pick<OrchestrationV2ThreadShell, "branch" | "pullRequests">,
): ThreadPullRequestLink | undefined {
  return visibleThreadPullRequests(thread.pullRequests ?? []).find(
    (link) => link.snapshot?.state === "open" && link.snapshot.headBranch === thread.branch,
  );
}

/** Where the thread's work lands, as the client's stack tree reads it. */
const stackBase = (thread: OrchestrationV2ThreadShell) =>
  ownOpenPullRequest(thread)?.snapshot?.baseBranch ?? thread.baseBranch ?? null;

/**
 * Linked pull requests that may be based on the merged branch. Native stack layers are left to
 * their host, and the host's answer decides: snapshots can be stale.
 */
function retargetCandidates(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  merged: Pick<
    PullRequestService.PullRequestMergeEvent,
    "projectId" | "repository" | "number" | "headBranch"
  >,
): ReadonlyArray<ThreadPullRequestLink> {
  const candidates = new Map<number, ThreadPullRequestLink>();
  for (const thread of threads) {
    if (thread.projectId !== merged.projectId) continue;
    for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
      if (link.number === merged.number || candidates.has(link.number)) continue;
      if (!sameRepository(link.repository, merged.repository) || link.stack !== null) continue;
      const snapshot = link.snapshot;
      if (snapshot !== null && snapshot.state !== "open") continue;
      const basedOnMerged =
        snapshot === null
          ? thread.baseBranch === merged.headBranch
          : snapshot.baseBranch === merged.headBranch;
      if (basedOnMerged) candidates.set(link.number, link);
    }
  }
  return [...candidates.values()];
}

const shouldRetarget = (
  summary: Pick<PullRequestSummary, "state" | "baseBranch" | "stack">,
  mergedHeadBranch: string,
) => summary.state === "open" && summary.baseBranch === mergedHeadBranch && summary.stack == null;

/** Why a restack cannot run unattended, or null when it can. */
function restackBlocker(input: {
  readonly thread: Pick<OrchestrationV2ThreadShell, "activeRunId" | "pendingRuntimeRequest">;
  readonly sharedCheckoutBusy?: boolean;
  readonly checkedOutBranch: string | null;
  readonly branch: string;
  readonly hasWorkingTreeChanges: boolean;
}): GitRestackHandoffReason | null {
  if (
    input.thread.activeRunId !== null ||
    input.thread.pendingRuntimeRequest !== null ||
    input.sharedCheckoutBusy === true
  ) {
    return "busy";
  }
  if (input.checkedOutBranch !== input.branch) return "checkout";
  if (input.hasWorkingTreeChanges) return "dirty";
  return null;
}

const HANDOFF_BECAUSE: Record<GitRestackHandoffReason, string> = {
  busy: "a turn was running",
  dirty: "the checkout has uncommitted changes, so commit or stash them first",
  conflict: "the rebase stopped on conflicts",
  checkout: "the checkout is not on this thread's branch",
};

function restackPrompt(input: {
  readonly reason: GitRestackHandoffReason;
  readonly branch: string;
  readonly onto: string;
  readonly from: string;
  readonly merged: boolean;
  readonly remote: string | null;
  readonly forkPoint?: string;
  readonly retargetFailed?: number;
}): string {
  const ontoRef =
    input.merged && input.remote !== null ? `${input.remote}/${input.onto}` : input.onto;
  const upstream = input.forkPoint === undefined ? `--fork-point ${input.from}` : input.forkPoint;
  return [
    input.merged
      ? `\`${input.from}\` was merged into \`${input.onto}\`, so \`${input.branch}\` now lands on \`${input.onto}\`.`
      : `\`${input.onto}\` has new commits that \`${input.branch}\` is stacked on.`,
    ...(input.retargetFailed === undefined
      ? []
      : [
          `T3 Code could not retarget pull request #${input.retargetFailed}; change its base to \`${input.onto}\` too.`,
        ]),
    `T3 Code could not rebase it for you: ${HANDOFF_BECAUSE[input.reason]}. Rebase this branch onto \`${input.onto}\`:`,
    "",
    "```sh",
    ...(input.merged && input.remote !== null ? [`git fetch ${input.remote} ${input.onto}`] : []),
    `git rebase --onto ${ontoRef} ${upstream}`,
    "```",
    "",
    "Resolve any conflicts keeping both sides' intent, check the project still builds, then `git push --force-with-lease` if the branch is pushed.",
  ].join("\n");
}

const MERGE_REPORT_MEMORY = 64;

export const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = Option.getOrUndefined(
    yield* Effect.serviceOption(GitWorkflowService.GitWorkflowService),
  );
  const projectService = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectService.ProjectService),
  );
  const random = yield* SecureRandom.SecureRandom;
  const reports = new Map<string, Deferred.Deferred<StackMergeReport>>();

  const projectThreads = (projectId: ProjectId) =>
    projections
      .getShellSnapshot({ projectId })
      .pipe(
        Effect.map((snapshot) => snapshot.threads.filter((thread) => thread.deletedAt === null)),
      );

  const resolveProjectRoot = (projectId: ProjectId) =>
    projectStore
      .getShell(projectId)
      .pipe(
        Effect.map((found) =>
          Option.isNone(found)
            ? ({ kind: "missing" } as const)
            : (found.value.trackedFolders?.length ?? 0) > 0
              ? ({ kind: "multi_repo" } as const)
              : ({ kind: "repo", root: found.value.workspaceRoot } as const),
        ),
      );

  const workspaceRoot = (projectId: ProjectId) =>
    resolveProjectRoot(projectId).pipe(
      Effect.map((resolved) => (resolved.kind === "repo" ? resolved.root : null)),
    );

  const tellAgent = Effect.fn("PullRequestStackService.tellAgent")(function* (
    thread: OrchestrationV2ThreadShell,
    text: string,
  ) {
    const uuid = yield* random.uuidV4();
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:restack:${thread.id}:${uuid}`),
      messageId: MessageId.make(`restack:${thread.id}:${uuid}`),
      threadId: thread.id,
      text,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
  });

  type RestackPlan = {
    readonly thread: OrchestrationV2ThreadShell;
    readonly root: string;
    readonly onto: string;
    readonly from: string;
    /** The parent merged on the host, so `onto` is read from the remote. */
    readonly merged: boolean;
    /** Fail instead of handing a blocked restack to the agent. */
    readonly mechanicalOnly: boolean;
    /** When set, verify local HEAD matches this reviewed commit before rebasing. */
    readonly expectedHeadSha?: string | undefined;
    readonly retargetFailed?: number;
  };

  const restackThreadWithHead = Effect.fn("PullRequestStackService.restackThread")(function* (
    plan: RestackPlan,
  ) {
    const { thread } = plan;
    const branch = thread.branch!;
    const cwd = thread.worktreePath ?? plan.root;
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const result = (
      outcome: GitRestackThreadResult["outcome"],
      extra: Partial<GitRestackThreadResult> = {},
    ) =>
      ({
        threadId: thread.id,
        branch,
        onto: plan.onto,
        outcome,
        ...extra,
      }) satisfies GitRestackThreadResult;
    const handOff = (reason: GitRestackHandoffReason, forkPoint?: string) =>
      plan.mechanicalOnly
        ? Effect.fail(
            new GitRestackError({
              threadId: thread.id,
              detail: `\`${branch}\` could not be rebased unattended: ${HANDOFF_BECAUSE[reason]}.`,
            }),
          )
        : tellAgent(
            thread,
            restackPrompt({
              reason,
              branch,
              onto: plan.onto,
              from: plan.from,
              merged: plan.merged,
              remote,
              ...(forkPoint === undefined ? {} : { forkPoint }),
              ...(plan.retargetFailed === undefined ? {} : { retargetFailed: plan.retargetFailed }),
            }),
          ).pipe(Effect.as({ result: result("agent-asked", { reason }), headSha: null }));

    const projects = projectService
      ? yield* projectService.snapshot.pipe(
          Effect.map((snapshot) => snapshot.projects),
          Effect.orElseSucceed(() => []),
        )
      : [];
    const { checkoutPaths, projectIds } = yield* resolveSharedCheckoutScope(cwd, {
      gitWorkflow,
      projects,
      fallbackProjectIds: cwd === plan.root ? [thread.projectId] : [],
    });
    const checkoutSnapshots = yield* Effect.forEach(
      [
        ...[...projectIds].map((projectId) => projections.getShellSnapshot({ projectId })),
        ...checkoutPaths.map((worktreePath) => projections.getShellSnapshot({ worktreePath })),
      ],
      (snapshot) =>
        snapshot.pipe(Effect.orElseSucceed(() => ({ threads: [], archivedThreads: [] }))),
      { concurrency: "unbounded" },
    );
    const sharedCheckoutBusy =
      busyThreadsInCheckout({
        checkoutPaths,
        projectIds,
        threads: checkoutSnapshots.flatMap((snapshot) => [
          ...snapshot.threads,
          ...snapshot.archivedThreads,
        ]),
        excludeThreadId: thread.id,
        includePendingRequests: true,
      }).length > 0;
    const status = yield* git.statusDetailsLocal(cwd);
    const blocker = restackBlocker({
      thread,
      sharedCheckoutBusy,
      branch,
      checkedOutBranch: status.branch,
      hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    });
    if (blocker !== null) return yield* handOff(blocker);

    if (plan.expectedHeadSha !== undefined) {
      const { commitSha: localHead } = yield* git.resolveCommit({ cwd, revision: "HEAD" });
      if (localHead !== plan.expectedHeadSha) {
        return yield* new GitRestackError({
          threadId: thread.id,
          detail: `\`${branch}\` local HEAD (${localHead.slice(0, 12)}) does not match pull request head (${plan.expectedHeadSha.slice(0, 12)}). Sync the branch before merging.`,
        });
      }
    }

    let onto = plan.onto;
    let from = plan.from;
    if (plan.merged && remote !== null) {
      yield* git.fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: plan.onto });
      onto = `${remote}/${plan.onto}`;
      const localFrom = yield* git
        .resolveCommit({ cwd, revision: `refs/heads/${plan.from}` })
        .pipe(Effect.option);
      if (Option.isNone(localFrom)) from = `${remote}/${plan.from}`;
    }
    const rebase = yield* git.rebaseOnto({ cwd, onto, from });
    if (rebase.status === "conflicted") return yield* handOff("conflict", rebase.forkPoint);
    const { commitSha: headSha } = yield* git.resolveCommit({ cwd, revision: "HEAD" });
    if (rebase.status === "up-to-date") return { result: result("up-to-date"), headSha };
    const push = yield* git.forcePushCurrentBranch(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          Effect.logWarning("restacked branch could not be force-pushed", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as("failed" as const)),
      }),
    );
    if (plan.mechanicalOnly && push !== "pushed") {
      return yield* new GitRestackError({
        threadId: thread.id,
        detail:
          push === "no-upstream"
            ? `\`${branch}\` was rebased but has no upstream branch to push to.`
            : `\`${branch}\` was rebased but could not be pushed.`,
      });
    }
    return {
      result: result("restacked", push === "no-upstream" ? {} : { pushed: push === "pushed" }),
      headSha,
    };
  });

  const restackThread = (plan: RestackPlan) =>
    restackThreadWithHead(plan).pipe(Effect.map((outcome) => outcome.result));

  /** Restack failures that are not handoffs become a typed error for the caller. */
  const restackOrFailWithHead = (plan: RestackPlan) =>
    restackThreadWithHead(plan).pipe(
      Effect.mapError((cause) =>
        cause._tag === "GitRestackError"
          ? cause
          : new GitRestackError({
              threadId: plan.thread.id,
              detail: `\`${plan.thread.branch}\` could not be rebased.`,
              cause,
            }),
      ),
    );

  const restackOrFail = (plan: RestackPlan) =>
    restackOrFailWithHead(plan).pipe(Effect.map((outcome) => outcome.result));

  const retargetAndRestack = Effect.fn("PullRequestStackService.retargetAndRestack")(function* (
    merged: PullRequestService.PullRequestMergeEvent,
  ) {
    const threads = yield* projectThreads(merged.projectId);
    const root = yield* workspaceRoot(merged.projectId);
    const retargeted: Array<{ readonly number: number; readonly headBranch: string }> = [];
    const failed: Array<{ readonly number: number; readonly headBranch: string }> = [];
    yield* Effect.forEach(
      retargetCandidates(threads, merged),
      (link) =>
        Effect.gen(function* () {
          const ref = {
            projectId: merged.projectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
          };
          const summary = yield* pullRequests.summary(ref);
          if (!shouldRetarget(summary, merged.headBranch)) return;
          yield* pullRequests.changeBaseBranch({ ...ref, baseBranch: merged.baseBranch }).pipe(
            Effect.matchEffect({
              onSuccess: () =>
                Effect.sync(() =>
                  retargeted.push({ number: link.number, headBranch: summary.headBranch }),
                ),
              onFailure: (error) =>
                Effect.logWarning("stacked pull request could not be retargeted after a merge", {
                  number: link.number,
                  error,
                }).pipe(
                  Effect.andThen(
                    Effect.sync(() =>
                      failed.push({ number: link.number, headBranch: summary.headBranch }),
                    ),
                  ),
                ),
            }),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("stacked pull request could not be read after a merge", {
              number: link.number,
              error,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );

    const retargetedHeads = new Set(retargeted.map((entry) => entry.headBranch));
    const failedHeads = new Map(failed.map((entry) => [entry.headBranch, entry.number]));
    const dependents = threads.filter(
      (thread) =>
        thread.branch !== null &&
        thread.branch !== merged.headBranch &&
        (retargetedHeads.has(thread.branch) ||
          failedHeads.has(thread.branch) ||
          thread.baseBranch === merged.headBranch),
    );
    const restacks: GitRestackThreadResult[] = [];
    yield* Effect.forEach(
      dependents,
      (thread) =>
        Effect.gen(function* () {
          const branch = thread.branch!;
          const retargetFailed = failedHeads.get(branch);
          const cwd = thread.worktreePath ?? root;
          if (retargetFailed === undefined) {
            if (thread.baseBranch !== merged.baseBranch) {
              const uuid = yield* random.uuidV4();
              yield* orchestrator.dispatch({
                type: "thread.metadata.update",
                commandId: CommandId.make(`server:stack-base:${thread.id}:${uuid}`),
                threadId: thread.id,
                baseBranch: merged.baseBranch,
              });
            }
            if (cwd !== null) {
              yield* git.writeBranchBase({ cwd, branch, baseBranch: merged.baseBranch });
            }
          }
          if (!merged.restackDependents || root === null) return;
          restacks.push(
            yield* restackThread({
              thread,
              root,
              onto: merged.baseBranch,
              from: merged.headBranch,
              merged: true,
              mechanicalOnly: false,
              ...(retargetFailed === undefined ? {} : { retargetFailed }),
            }),
          );
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("stacked thread could not follow its merged parent", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    return {
      retargeted: retargeted.map((entry) => entry.number),
      failed: failed.map((entry) => entry.number),
      restacks,
    } satisfies StackMergeReport;
  });

  const afterMerge: PullRequestStackService["Service"]["afterMerge"] = Effect.fn(
    "PullRequestStackService.afterMerge",
  )(function* (merged) {
    const key = `${merged.projectId}\n${merged.repository.toLowerCase()}\n${merged.number}`;
    const existing = reports.get(key);
    if (existing !== undefined) return yield* Deferred.await(existing);
    const report = yield* Deferred.make<StackMergeReport>();
    reports.set(key, report);
    if (reports.size > MERGE_REPORT_MEMORY) reports.delete(reports.keys().next().value!);
    const empty: StackMergeReport = { retargeted: [], failed: [], restacks: [] };
    const outcome = yield* retargetAndRestack(merged).pipe(
      Effect.catch((error) =>
        Effect.logWarning("stacked pull requests were not updated after a merge", {
          number: merged.number,
          error,
        }).pipe(Effect.as(empty)),
      ),
      Effect.onInterrupt(() =>
        Deferred.succeed(report, empty).pipe(
          Effect.andThen(Effect.sync(() => reports.delete(key))),
        ),
      ),
    );
    yield* Deferred.succeed(report, outcome);
    return outcome;
  });

  const restackDependents: PullRequestStackService["Service"]["restackDependents"] = Effect.fn(
    "PullRequestStackService.restackDependents",
  )(function* (input) {
    const failure = (detail: string) => (cause: unknown) =>
      new GitRestackError({ threadId: input.threadId, detail, cause });
    const parent = yield* projections
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(failure("The thread could not be read.")));
    if (parent === null || parent.deletedAt !== null) {
      return yield* new GitRestackError({
        threadId: input.threadId,
        detail: "The thread was not found.",
      });
    }
    const parentBranch = parent.branch;
    if (parentBranch === null) {
      return yield* new GitRestackError({
        threadId: input.threadId,
        detail: "The thread has no branch.",
      });
    }
    const threads = yield* projectThreads(parent.projectId).pipe(
      Effect.mapError(failure("The project's threads could not be read.")),
    );
    const projectRoot = yield* resolveProjectRoot(parent.projectId).pipe(
      Effect.mapError(failure("The project could not be read.")),
    );
    if (projectRoot.kind === "multi_repo") {
      return yield* new GitRestackError({
        threadId: input.threadId,
        detail: "Restacking stacked branches is not supported for multi-repo projects.",
      });
    }
    if (projectRoot.kind === "missing") {
      return yield* new GitRestackError({
        threadId: input.threadId,
        detail: "The project was not found.",
      });
    }
    const root = projectRoot.root;
    const children = threads.filter(
      (thread) =>
        thread.id !== parent.id &&
        thread.branch !== null &&
        thread.branch !== parentBranch &&
        stackBase(thread) === parentBranch,
    );
    const restacked = yield* Effect.forEach(
      children,
      (thread) =>
        restackOrFail({
          thread,
          root,
          onto: parentBranch,
          from: parentBranch,
          merged: false,
          mechanicalOnly: false,
        }),
      { concurrency: 1 },
    );
    return { threads: restacked };
  });

  const mergeStack: PullRequestStackService["Service"]["mergeStack"] = Effect.fn(
    "PullRequestStackService.mergeStack",
  )(function* (input) {
    const stop = (detail: string, cause?: unknown) =>
      new PullRequestOperationError({
        operation: "mergeStack",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const ref = {
      projectId: input.projectId,
      repository: input.repository,
      ...(input.host === undefined ? {} : { host: input.host }),
    };
    const target = yield* pullRequests.summary(
      { ...ref, number: input.number, allowStale: false },
      { bypassCache: true },
    );
    if (target.state !== "open") return yield* stop(`#${target.number} is not open.`);

    // Strict native-first precedence: consult the host's native stack API whenever the host
    // supports native stacks or the PR reports native membership, and never fall back on failure.
    const nativeSupported = yield* pullRequests.supportsNativeStacks({
      ...ref,
      number: target.number,
    });
    if (nativeSupported || target.stack != null) {
      const nativeStack = yield* pullRequests.stack(
        { ...ref, number: target.number },
        { bypassCache: true },
      );
      if (nativeStack !== null) {
        if (nativeSupported) {
          return yield* mergeNativeStack(pullRequests, input, nativeStack);
        }
        // Native-stack host without a separate stack action (such as TanStack Source): merging
        // the target PR directly lands every unmerged layer below it on its own.
        const targetIndex = nativeStack.layers.findIndex((layer) => layer.number === target.number);
        if (
          targetIndex < 0 ||
          (input.requireMultiLayer === true && nativeStack.layers.length <= 1)
        ) {
          return yield* stop(
            `PR #${target.number} is not in a stack this host can merge. Merge it without stack.`,
          );
        }
        const mergedLayers = nativeStack.layers
          .slice(0, targetIndex + 1)
          .filter((layer) => layer.state !== "merged")
          .map((layer) => layer.number);
        const resolvedExpectedHeadSha =
          input.expectedHeadSha === undefined
            ? undefined
            : target.headSha !== undefined &&
                PullRequestService.isHeadSha(target.headSha, input.expectedHeadSha)
              ? target.headSha
              : null;
        if (resolvedExpectedHeadSha === null) {
          return yield* stop(
            `PR #${target.number} moved since it was read (expected ${input.expectedHeadSha}, found ${target.headSha ?? "unknown"}).`,
          );
        }
        yield* pullRequests.runAction({
          ...ref,
          number: target.number,
          action: "merge",
          ...(resolvedExpectedHeadSha === undefined
            ? {}
            : { expectedHeadSha: resolvedExpectedHeadSha }),
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        });
        return { merged: mergedLayers.length > 0 ? mergedLayers : [target.number] };
      }
      if (target.stack != null) {
        return yield* stop(
          `#${target.number} is in a stack its host manages; merge it from that stack.`,
        );
      }
    }

    const threads = yield* projectThreads(target.projectId).pipe(
      Effect.mapError((cause) => stop("The project's threads could not be read.", cause)),
    );
    const projectRoot = yield* resolveProjectRoot(target.projectId).pipe(
      Effect.mapError((cause) => stop("The project could not be read.", cause)),
    );
    if (projectRoot.kind === "multi_repo") {
      return yield* stop("Stack merge is not supported for multi-repo projects.");
    }
    const root = projectRoot.kind === "repo" ? projectRoot.root : null;
    const chain: PullRequestSummary[] = [target];
    while (true) {
      const below = chain[0]!;
      const link = threads
        .flatMap((thread) => visibleThreadPullRequests(thread.pullRequests ?? []))
        .find(
          (candidate) =>
            sameRepository(candidate.repository, target.repository) &&
            candidate.stack === null &&
            candidate.snapshot?.state === "open" &&
            candidate.snapshot.headBranch === below.baseBranch &&
            !chain.some((member) => member.number === candidate.number),
        );
      if (link === undefined) break;
      const parent = yield* pullRequests.summary(
        { ...ref, number: link.number, allowStale: false },
        { bypassCache: true },
      );
      if (parent.state !== "open" || parent.headBranch !== below.baseBranch) break;
      chain.unshift(parent);
    }

    if (input.requireMultiLayer === true && chain.length <= 1) {
      return yield* stop(
        `PR #${target.number} is not in a stack this host can merge. Merge it without stack.`,
      );
    }
    for (const layer of chain) {
      if (!layer.headSha) {
        return yield* stop(
          `The host did not report PR #${layer.number}'s head, so the stack cannot be pinned. Try again.`,
        );
      }
    }
    if (
      input.expectedHeadSha !== undefined &&
      !PullRequestService.isHeadSha(target.headSha ?? "", input.expectedHeadSha)
    ) {
      return yield* stop(
        `PR #${target.number} moved since it was read (expected ${input.expectedHeadSha}, found ${target.headSha ?? "unknown"}).`,
      );
    }

    const merged: number[] = [];
    let currentLayerHeadSha: string = chain[0]!.headSha!;
    for (const [index, layer] of chain.entries()) {
      const stoppedBefore = (reason: string) =>
        merged.length === 0
          ? reason
          : `${reason} Merged ${merged.map((number) => `#${number}`).join(", ")} first.`;
      yield* pullRequests
        .runAction({
          ...ref,
          number: layer.number,
          action: "merge",
          expectedHeadSha: currentLayerHeadSha,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(
          Effect.mapError((cause) =>
            stop(stoppedBefore(`#${layer.number} could not be merged.`), cause),
          ),
        );
      const confirmed = yield* pullRequests.summary(
        { ...ref, number: layer.number, allowStale: false },
        { bypassCache: true },
      );
      if (confirmed.state !== "merged") {
        return yield* stop(
          stoppedBefore(
            `#${layer.number} did not merge yet; it may be queued or waiting on checks.`,
          ),
        );
      }
      merged.push(layer.number);
      const next = chain[index + 1];
      if (next === undefined) break;
      yield* afterMerge({
        projectId: target.projectId,
        repository: target.repository,
        number: layer.number,
        mergedAt: confirmed.mergedAt ?? confirmed.updatedAt,
        headBranch: confirmed.headBranch,
        baseBranch: confirmed.baseBranch,
        restackDependents: false,
      });
      const nextRef = { ...ref, number: next.number };
      const nextBeforeRestack = yield* pullRequests
        .summary({ ...nextRef, allowStale: false }, { bypassCache: true })
        .pipe(
          Effect.mapError((cause) =>
            stop(stoppedBefore(`#${next.number} could not be read before restacking.`), cause),
          ),
        );
      if (!nextBeforeRestack.headSha || nextBeforeRestack.headSha !== next.headSha) {
        return yield* stop(
          stoppedBefore(
            `#${next.number} moved while merging #${layer.number}. Review the new commits before continuing.`,
          ),
        );
      }
      // The top of the stack may have no thread link for the merge follow-up to find.
      if (nextBeforeRestack.baseBranch === confirmed.headBranch) {
        yield* pullRequests
          .changeBaseBranch({ ...nextRef, baseBranch: confirmed.baseBranch })
          .pipe(
            Effect.mapError((cause) =>
              stop(
                stoppedBefore(
                  `#${next.number} could not be retargeted to \`${confirmed.baseBranch}\`.`,
                ),
                cause,
              ),
            ),
          );
      }
      const ownerId = threads.find((thread) => thread.branch === next.headBranch)?.id;
      const owner =
        ownerId === undefined
          ? null
          : yield* projections
              .getThreadShell(ownerId)
              .pipe(Effect.mapError((cause) => stop("The thread could not be read.", cause)));
      if (owner === null || root === null) {
        return yield* stop(stoppedBefore(`#${next.number} has no thread to restack it in.`));
      }
      const restackOutcome = yield* restackOrFailWithHead({
        thread: owner,
        root,
        onto: confirmed.baseBranch,
        from: confirmed.headBranch,
        merged: true,
        mechanicalOnly: true,
        expectedHeadSha: next.headSha!,
      }).pipe(Effect.mapError((cause) => stop(stoppedBefore(cause.detail), cause)));
      if (!restackOutcome.headSha) {
        return yield* stop(
          stoppedBefore(`#${next.number} could not resolve its restacked commit.`),
        );
      }
      const refreshedNext = yield* pullRequests
        .summary({ ...nextRef, allowStale: false }, { bypassCache: true })
        .pipe(
          Effect.mapError((cause) =>
            stop(stoppedBefore(`#${next.number} could not be re-read after restacking.`), cause),
          ),
        );
      if (!refreshedNext.headSha || refreshedNext.headSha !== restackOutcome.headSha) {
        return yield* stop(
          stoppedBefore(
            `#${next.number} head on the host (${refreshedNext.headSha ?? "unknown"}) does not match the restacked commit (${restackOutcome.headSha}).`,
          ),
        );
      }
      currentLayerHeadSha = refreshedNext.headSha;
    }
    return { merged };
  });

  const start: PullRequestStackService["Service"]["start"] = Effect.fn(
    "PullRequestStackService.start",
  )(function* () {
    const merges = yield* pullRequests.subscribeMerges;
    yield* forkParked(Stream.runForEach(merges, (merged) => afterMerge(merged)));
  });

  return PullRequestStackService.of({ start, afterMerge, restackDependents, mergeStack });
});

export const layer = Layer.effect(PullRequestStackService, make);
