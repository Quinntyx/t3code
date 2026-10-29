import type {
  EnvironmentId,
  EnvironmentMachineKind,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./state/threadSettled.ts";
import { getThreadSortTimestamp } from "./state/threadSort.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;
const COMPOSER_THREAD_TRIGGER_RESULT_LIMIT = 20;

export type ComposerThreadCandidate = ThreadSearchShell &
  ThreadSnoozeShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage" | "settledOverride">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

interface ComposerThreadMatchInput {
  readonly shells: ReadonlyArray<ComposerThreadCandidate>;
  readonly environmentId: EnvironmentId;
  /** The machines the composer's environment links to, by name. */
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly excludeThreadId: ThreadId | null;
  readonly query: string;
  /** Recency is measured against this time. */
  readonly now: number;
}

/**
 * The agent reads threads on its own server and on the machines it links to, so
 * candidates stay within those. Subagent threads are left out.
 */
function mentionableThreads(input: ComposerThreadMatchInput) {
  return input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      shell.lineage.relationshipToParent !== "subagent",
  );
}

function rankThreadMatches(
  candidates: ReadonlyArray<ComposerThreadCandidate>,
  query: string,
  now: number,
) {
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), now, {
      ...options,
      picks: false,
    }),
  ).map(({ item }) => item);
}

function composerThreadItem(
  shell: ComposerThreadCandidate,
  input: ComposerThreadMatchInput,
  noun: string,
): ComposerThreadItem {
  // A linked machine's threads say which machine they are on.
  const machine =
    shell.environmentId === input.environmentId
      ? undefined
      : input.linkedEnvironments.get(shell.environmentId);
  return {
    id: `thread:${shell.environmentId}:${shell.id}`,
    type: "thread",
    thread: { environmentId: shell.environmentId, threadId: shell.id },
    label: shell.title,
    description: machine === undefined ? noun : `${noun} on ${machine}`,
  };
}

/** Threads to reference from the `@` picker, matched and ranked like the command palette. */
export function matchComposerThreadItems(input: ComposerThreadMatchInput): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  return rankThreadMatches(mentionableThreads(input), query, input.now)
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => composerThreadItem(shell, input, "Thread"));
}

const THREAD_SECTION_LABELS = ["Active", "Snoozed", "Settled"] as const;

function threadSectionIndex(shell: ComposerThreadCandidate, now: string): number {
  if (effectiveSnoozed(shell, { now })) return 1;
  return shell.settledOverride === "settled" ? 2 : 0;
}

/**
 * Threads for the `%` picker. The query only filters, with the palette's matching; matches
 * list in the sidebar's sections, active then snoozed then settled, newest first in each.
 * A bare `%` lists every thread that way.
 */
export function matchComposerThreadTriggerItems(
  input: ComposerThreadMatchInput,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  const candidates = mentionableThreads(input);
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
    .map(({ shell, section }) => composerThreadItem(shell, input, THREAD_SECTION_LABELS[section]!));
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
export function matchComposerEnvironmentItems(input: {
  environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerEnvironmentItem[] {
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
      description: "Machine",
    }));
}
