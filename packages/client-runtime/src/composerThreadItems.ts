import {
  isListedThreadLineage,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./state/threadSettled.ts";
import { getThreadSortTimestamp } from "./state/threadSort.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const COMPOSER_THREAD_RESULT_LIMIT = 5;
const COMPOSER_THREAD_TRIGGER_RESULT_LIMIT = 20;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export type ComposerThreadTriggerCandidate = ComposerThreadCandidate &
  ThreadSnoozeShell &
  Pick<EnvironmentThreadShell, "settledOverride">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

interface ComposerThreadMatchInput<
  TCandidate extends ComposerThreadCandidate = ComposerThreadCandidate,
> {
  readonly shells: ReadonlyArray<TCandidate>;
  readonly environmentId: EnvironmentId;
  /** The machines the composer's environment links to, by name. */
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly excludeThreadId: ThreadId | null;
  readonly query: string;
  /** Recency is measured against this time. */
  readonly now: number;
}

function isOwnSideChat(
  shell: ComposerThreadCandidate,
  input: Pick<ComposerThreadMatchInput, "environmentId" | "excludeThreadId">,
): boolean {
  // Closing an unused side chat deletes it, so only one with a message is offered.
  return (
    shell.lineage.sideChat === true &&
    shell.environmentId === input.environmentId &&
    shell.lineage.parentThreadId === input.excludeThreadId &&
    shell.latestUserMessageAt !== null
  );
}

function mentionableThreads<TCandidate extends ComposerThreadCandidate>(
  input: ComposerThreadMatchInput<TCandidate>,
  includeOwnSideChats: boolean,
): TCandidate[] {
  return input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      (isListedThreadLineage(shell.lineage) ||
        (includeOwnSideChats && isOwnSideChat(shell, input))),
  );
}

function rankThreadMatches<TCandidate extends ComposerThreadCandidate>(
  candidates: ReadonlyArray<TCandidate>,
  query: string,
  now: number,
): TCandidate[] {
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), now, {
      ...options,
      picks: false,
    }),
  ).map(({ item }) => item);
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent threads or other threads' side chats. The agent reads threads
 * on its own server and on the machines it links to, so candidates stay within those, and a
 * linked machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(
  input: ComposerThreadMatchInput,
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = mentionableThreads(input, true);
  return rankThreadMatches(candidates, query, input.now)
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: isOwnSideChat(shell, input)
          ? resolve(msg("Side chat"))
          : machine === undefined
            ? resolve(msg("Thread", { $context: "noun, search result type" }))
            : resolve(msg("Thread on {machine}", { machine })),
      };
    });
}

function threadSectionIndex(shell: ComposerThreadTriggerCandidate, now: string): number {
  if (effectiveSnoozed(shell, { now })) return 1;
  return shell.settledOverride === "settled" ? 2 : 0;
}

function threadSectionDescription(
  section: number,
  machine: string | undefined,
  resolve: MFunctionType,
): string {
  if (section === 1) {
    return machine === undefined
      ? resolve(msg("Snoozed"))
      : resolve(msg("Snoozed on {machine}", { machine }));
  }
  if (section === 2) {
    return machine === undefined
      ? resolve(msg("Settled"))
      : resolve(msg("Settled on {machine}", { machine }));
  }
  return machine === undefined
    ? resolve(msg("Active"))
    : resolve(msg("Active on {machine}", { machine }));
}

/**
 * Threads for the `%` picker. The query only filters, with the palette's matching; matches
 * list in the sidebar's sections, active then snoozed then settled, newest first in each.
 * A bare `%` lists every thread that way.
 */
export function matchComposerThreadTriggerItems(
  input: ComposerThreadMatchInput<ComposerThreadTriggerCandidate>,
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  const candidates = mentionableThreads(input, true);
  const matches = query.length === 0 ? candidates : rankThreadMatches(candidates, query, input.now);
  // @effect-diagnostics-next-line globalDate:off - Snooze checks compare wall-clock ISO times.
  const now = new Date(input.now).toISOString();
  return matches
    .map((shell) => ({
      shell,
      section: threadSectionIndex(shell, now),
      activityAt: getThreadSortTimestamp(shell, "updated_at"),
    }))
    .sort((left, right) => left.section - right.section || right.activityAt - left.activityAt)
    .slice(0, COMPOSER_THREAD_TRIGGER_RESULT_LIMIT)
    .map(({ shell, section }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: isOwnSideChat(shell, input)
          ? resolve(msg("Side chat"))
          : threadSectionDescription(section, machine, resolve),
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(
  input: {
    environments: ReadonlyArray<ComposerEnvironmentCandidate>;
    environmentId: EnvironmentId;
    query: string;
  },
  resolve: MFunctionType = mFallback,
): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: resolve(msg("Machine", { $context: "noun, search result type" })),
    }));
}
