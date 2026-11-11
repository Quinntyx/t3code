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

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
      input: PullRequestMergeStackInput,
    ) => Effect.Effect<PullRequestMergeStackResult, PullRequestService.PullRequestError>;
  }
>()("t3/pullRequest/PullRequestStackService") {}

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
  readonly checkedOutBranch: string | null;
  readonly branch: string;
  readonly hasWorkingTreeChanges: boolean;
}): GitRestackHandoffReason | null {
  if (input.thread.activeRunId !== null || input.thread.pendingRuntimeRequest !== null) {
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
  const random = yield* SecureRandom.SecureRandom;
  const reports = new Map<string, Deferred.Deferred<StackMergeReport>>();

  const projectThreads = (projectId: ProjectId) =>
    projections
      .getShellSnapshot({ projectId })
      .pipe(
        Effect.map((snapshot) => snapshot.threads.filter((thread) => thread.deletedAt === null)),
      );

  const workspaceRoot = (projectId: ProjectId) =>
    projectStore
      .getShell(projectId)
      .pipe(
        Effect.map(Option.map((project) => project.workspaceRoot)),
        Effect.map(Option.getOrNull),
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
    readonly retargetFailed?: number;
  };

  const restackThread = Effect.fn("PullRequestStackService.restackThread")(function* (
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
          ).pipe(Effect.as(result("agent-asked", { reason })));

    const status = yield* git.statusDetailsLocal(cwd);
    const blocker = restackBlocker({
      thread,
      branch,
      checkedOutBranch: status.branch,
      hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    });
    if (blocker !== null) return yield* handOff(blocker);

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
    if (rebase.status === "up-to-date") return result("up-to-date");
    const push = yield* git.forcePushCurrentBranch(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          Effect.logWarning("restacked branch could not be force-pushed", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as("failed" as const)),
      }),
    );
    if (push === "failed" && plan.mechanicalOnly) {
      return yield* new GitRestackError({
        threadId: thread.id,
        detail: `\`${branch}\` was rebased but could not be pushed.`,
      });
    }
    return result("restacked", push === "no-upstream" ? {} : { pushed: push === "pushed" });
  });

  /** Restack failures that are not handoffs become a typed error for the caller. */
  const restackOrFail = (plan: RestackPlan) =>
    restackThread(plan).pipe(
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
    const root = yield* workspaceRoot(parent.projectId).pipe(
      Effect.mapError(failure("The project could not be read.")),
    );
    if (root === null) {
      return yield* new GitRestackError({
        threadId: input.threadId,
        detail: "The project was not found.",
      });
    }
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
    const target = yield* pullRequests.summary({ ...ref, number: input.number });
    if (target.state !== "open") return yield* stop(`#${target.number} is not open.`);
    if (target.stack != null) {
      return yield* stop(
        `#${target.number} is in a stack its host manages; merge it from that stack.`,
      );
    }
    const threads = yield* projectThreads(target.projectId).pipe(
      Effect.mapError((cause) => stop("The project's threads could not be read.", cause)),
    );
    const root = yield* workspaceRoot(target.projectId).pipe(
      Effect.mapError((cause) => stop("The project could not be read.", cause)),
    );
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
      const parent = yield* pullRequests.summary({ ...ref, number: link.number });
      if (parent.state !== "open" || parent.headBranch !== below.baseBranch) break;
      chain.unshift(parent);
    }

    const merged: number[] = [];
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
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(
          Effect.mapError((cause) =>
            stop(stoppedBefore(`#${layer.number} could not be merged.`), cause),
          ),
        );
      const confirmed = yield* pullRequests.summary({ ...ref, number: layer.number });
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
      // The top of the stack may have no thread link for the merge follow-up to find.
      if ((yield* pullRequests.summary(nextRef)).baseBranch === confirmed.headBranch) {
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
      yield* restackOrFail({
        thread: owner,
        root,
        onto: confirmed.baseBranch,
        from: confirmed.headBranch,
        merged: true,
        mechanicalOnly: true,
      }).pipe(Effect.mapError((cause) => stop(stoppedBefore(cause.detail), cause)));
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
