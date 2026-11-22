import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  isOrchestrationV2WorkActive,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";

const isFinishedAgentStatus = (status: string | null | undefined) =>
  ["completed", "failed", "error", "cancelled", "interrupted", "idle"].includes(status ?? "");

export interface RailAgentRow {
  readonly kind: "agent";
  readonly id: string;
  readonly title: string;
  readonly status: string | null;
  readonly providerInstanceId: string;
  readonly driver: OrchestrationV2Subagent["driver"];
  readonly childThreadId: ThreadIdType | null;
  readonly workflowName: string | null;
}

export interface RailRemoteAgentRow {
  readonly kind: "remote";
  readonly id: string;
  readonly title: string;
  readonly status: string | null;
  readonly environmentLabel: string;
  readonly providerInstanceId: string;
  readonly driver: OrchestrationV2Subagent["driver"];
}

export interface RailSideChatRow {
  readonly kind: "sideChat";
  readonly id: string;
  readonly title: string;
  readonly status: string | null;
  readonly threadId: ThreadIdType;
  /** The side chat's shell, which the side-chat tab opens with. */
  readonly shell: OrchestrationV2ThreadShell | null;
}

/** `divider` names the workflow the row opens, or the next stage it starts inside one. */
export type RailRow = (RailAgentRow | RailRemoteAgentRow) & {
  readonly divider: string | null;
};

/** A workflow's active members, split by the stage each one runs in. */
function workflowRows(
  group: SubagentWorkflowGroup,
  coordinator: OrchestrationV2Subagent,
): RailRow[] {
  const name = group.workflow.workflowName ?? group.workflow.title;
  const row = (member: RuntimeSubagent, divider: string | null): RailRow => ({
    kind: "agent",
    id: member.id,
    title: member.title,
    status: member.status,
    providerInstanceId: coordinator.providerInstanceId,
    driver: coordinator.driver,
    childThreadId: member.childThreadId === null ? null : ThreadId.make(member.childThreadId),
    workflowName: name,
    divider,
  });
  const rows: RailRow[] = [];
  for (const phase of group.phases) {
    const live = phase.members.filter((member) => !isFinishedAgentStatus(member.status));
    // Only the stage's first member carries its divider; the rest continue that stage.
    live.forEach((member, index) =>
      rows.push(row(member, index === 0 ? `${name} · ${phase.title}` : null)),
    );
  }
  for (const member of group.unphasedMembers) {
    if (!isFinishedAgentStatus(member.status))
      rows.push(row(member, rows.length === 0 ? name : null));
  }
  return rows;
}

/**
 * The rail lists active agents newest first. A workflow's members stay together at the
 * coordinator's place, because they are one unit of work, split only by stage. A divider marks
 * where a workflow starts and where it ends.
 */
export function buildRailRows(
  projection: Pick<OrchestrationV2ThreadProjection, "subagents"> | null,
): RailRow[] {
  const workflowGroups = deriveWorkflowGroups(
    projectedSubagentsToRuntime(projection?.subagents ?? []),
  );
  const workflowsById = new Map(workflowGroups.map((group) => [group.workflow.id, group]));
  const activeAgents = (projection?.subagents ?? [])
    .filter(
      (agent) =>
        agent.remoteChild === undefined &&
        (isOrchestrationV2WorkActive(agent.status) || agent.workflow !== undefined),
    )
    .sort((left, right) =>
      DateTime.formatIso(right.startedAt ?? right.updatedAt).localeCompare(
        DateTime.formatIso(left.startedAt ?? left.updatedAt),
      ),
    );
  const rows: RailRow[] = [];
  let workflowExitDivider: string | null = null;
  for (const agent of activeAgents) {
    const group = workflowsById.get(agent.id);
    if (group !== undefined) {
      const workflowRowsForAgent = workflowRows(group, agent);
      if (workflowRowsForAgent.length === 0) continue;
      rows.push(...workflowRowsForAgent);
      workflowExitDivider = group.workflow.workflowName ?? group.workflow.title;
      continue;
    }
    rows.push({
      kind: "agent",
      id: agent.id,
      title: agent.title ?? m(msg("Subagent")),
      status: agent.status,
      providerInstanceId: agent.providerInstanceId,
      driver: agent.driver,
      childThreadId: agent.childThreadId,
      workflowName: null,
      divider: workflowExitDivider,
    });
    workflowExitDivider = null;
  }
  for (const agent of projection?.subagents ?? []) {
    if (agent.remoteChild === undefined || isFinishedAgentStatus(agent.status)) continue;
    rows.push({
      kind: "remote",
      id: agent.id,
      title: agent.title ?? m(msg("Subagent")),
      status: agent.status,
      environmentLabel: agent.remoteChild.label,
      providerInstanceId: agent.providerInstanceId,
      driver: agent.driver,
      divider: null,
    });
  }
  return rows;
}

/** The thread's side chats, in the order the lineage rows show them. */
export function buildRailSideChats(input: {
  readonly threadId: ThreadIdType;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly isHidden: (threadId: ThreadIdType) => boolean;
}): RailSideChatRow[] {
  const graph = deriveThreadRelationshipGraph({
    threads: input.shells,
    projection: input.projection,
  });
  return immediateThreadRelationships(graph, input.threadId)
    .filter((row) => !isParentThreadRelationship(row.edge, input.threadId))
    .flatMap((row) => {
      const node = graph.nodes.get(row.threadId);
      if (node?.thread?.lineage.sideChat !== true) return [];
      if (input.isHidden(row.threadId)) return [];
      return [
        {
          kind: "sideChat" as const,
          id: `side-chat:${row.threadId}`,
          title: node.thread.title,
          status: node.thread.activityRunStatus ?? node.thread.status,
          threadId: row.threadId,
          shell: node.thread,
        },
      ];
    });
}
