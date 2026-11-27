import {
  repositoryGroupingKeyOf,
  SCRATCH_KEY_MAX_CHARS,
  ScratchKey,
  type EnvironmentId,
  type ScratchSummary,
} from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";

const NO_PROJECT_PREFIX = "no-project:";
const REPOSITORY_PREFIX = "repo:";
const PATH_PREFIX = "path:";

function hashScratchKeySuffix(value: string): string {
  // Deterministic 64-bit FNV-1a hex suffix so truncated long paths stay collision-resistant.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function boundedScratchKey(raw: string): ScratchKey {
  if (raw.length <= SCRATCH_KEY_MAX_CHARS) return ScratchKey.make(raw);
  const suffix = `::${hashScratchKeySuffix(raw)}`;
  const prefixLength = Math.max(0, SCRATCH_KEY_MAX_CHARS - suffix.length);
  return ScratchKey.make(`${raw.slice(0, prefixLength)}${suffix}`);
}

type ScratchProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

/**
 * Mirrors the repository-relative path used for subdirectory project groups, so a scratch
 * document follows its folder when the repository root is cloned elsewhere.
 */
function deriveRepositoryRelativePath(
  project: Pick<ScratchProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) return null;

  const normalizedProjectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) return null;
  if (normalizedProjectPath === normalizedRootPath) return "";

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) return null;

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

/**
 * A `no-project:` key stays inside one machine: no checkout, no shared repository root, so
 * the documents on two machines are unrelated drafts rather than one shared page.
 */
export function deriveScratchKey(project: ScratchProject): ScratchKey {
  if (project.isScratch) return boundedScratchKey(`${NO_PROJECT_PREFIX}${project.environmentId}`);

  const canonicalKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  // A NUL reserves the scratch key namespace outside valid repository identities.
  if (canonicalKey && canonicalKey.length > 0 && !canonicalKey.includes("\0")) {
    const relativePath = deriveRepositoryRelativePath(project);
    return boundedScratchKey(
      relativePath && relativePath.length > 0
        ? `${REPOSITORY_PREFIX}${canonicalKey}::${relativePath}`
        : `${REPOSITORY_PREFIX}${canonicalKey}`,
    );
  }

  return boundedScratchKey(
    `${PATH_PREFIX}${project.environmentId}:${normalizeProjectPathForComparison(project.workspaceRoot)}`,
  );
}

export interface EstablishedScratchOwner {
  readonly environmentId: EnvironmentId;
  readonly revision: number;
}

export interface ResolveScratchOwnerEnvironmentInput {
  readonly scratchKey: ScratchKey;
  readonly memberEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly summariesByEnvironmentId: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<ScratchKey, ScratchSummary>
  >;
  /**
   * Previously observed owner with committed content. Kept authoritative across transient
   * disconnects so another machine's empty/stale SQLite database never forks the document.
   */
  readonly establishedOwner?: EstablishedScratchOwner | null;
}

export function isSharedRepositoryScratchKey(scratchKey: ScratchKey): boolean {
  return (scratchKey as string).startsWith(REPOSITORY_PREFIX);
}

function smallestEnvironmentId(candidates: ReadonlyArray<EnvironmentId>): EnvironmentId | null {
  let smallest: EnvironmentId | null = null;
  for (const candidate of candidates) {
    if (smallest === null || candidate < smallest) smallest = candidate;
  }
  return smallest;
}

function updatedAtMillis(summary: ScratchSummary): number {
  const parsed = Date.parse(summary.updatedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Every machine that shares a logical project key can serve the same document, so one of them
 * owns it: the machine holding the newest content, else the smallest id for a stable choice.
 * Once an owner has committed revisions, it stays authoritative across disconnects rather than
 * failing over writes to another machine's stale or empty database.
 */
export function resolveScratchOwnerEnvironment(
  input: ResolveScratchOwnerEnvironmentInput,
): EnvironmentId | null {
  const members = [...new Set(input.memberEnvironmentIds)];
  if (members.length === 0) return null;

  if ((input.scratchKey as string).startsWith(NO_PROJECT_PREFIX)) {
    const keyedEnvironmentId = (input.scratchKey as string).slice(NO_PROJECT_PREFIX.length);
    const match = members.find((environmentId) => (environmentId as string) === keyedEnvironmentId);
    return match ?? smallestEnvironmentId(members);
  }
  if ((input.scratchKey as string).startsWith(PATH_PREFIX)) {
    const rest = (input.scratchKey as string).slice(PATH_PREFIX.length);
    const orderedByLength = [...members].sort((a, b) => b.length - a.length);
    const match = orderedByLength.find((environmentId) => rest.startsWith(`${environmentId}:`));
    return match ?? smallestEnvironmentId(members);
  }

  const connected = members.filter((environmentId) =>
    input.connectedEnvironmentIds.has(environmentId),
  );
  const candidates = connected.length > 0 ? connected : members;

  const ordered = [...candidates].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  let owner: EnvironmentId | null = null;
  let ownerRevision = -1;
  let ownerUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const environmentId of ordered) {
    const summary = input.summariesByEnvironmentId.get(environmentId)?.get(input.scratchKey);
    if (summary === undefined || (summary.revision === 0 && !summary.hasContent)) continue;
    const updatedAt = updatedAtMillis(summary);
    if (
      owner === null ||
      summary.revision > ownerRevision ||
      (summary.revision === ownerRevision && updatedAt > ownerUpdatedAt)
    ) {
      owner = environmentId;
      ownerRevision = summary.revision;
      ownerUpdatedAt = updatedAt;
    }
  }

  const established = input.establishedOwner;
  if (established != null && established.revision > 0 && ownerRevision <= established.revision) {
    return established.environmentId;
  }

  return owner ?? smallestEnvironmentId(ordered);
}
