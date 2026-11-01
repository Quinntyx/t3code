import { useAtomValue } from "@effect/atom-react";
import { deusTaskSections, type DeusConversationView } from "@t3tools/client-runtime/state/deus";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DeusInputId,
  type DeusLearningStatus,
  type DeusMemory,
  type DeusTask,
  type DeusTaskActionInput,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { deusEnvironment } from "../../state/deus";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function DeusDetails({ view }: { view: DeusConversationView }) {
  const ref = view.session;
  const allowed = {
    task: useAtomValue(deusEnvironment.taskAction.permissionAtom(ref.environmentId)),
    reset: useAtomValue(deusEnvironment.resetConversation.permissionAtom(ref.environmentId)),
    read: useAtomValue(deusEnvironment.memorySearch.permissionAtom(ref.environmentId)),
    evidence: useAtomValue(deusEnvironment.memoryRead.permissionAtom(ref.environmentId)),
    correct: useAtomValue(deusEnvironment.memoryCorrect.permissionAtom(ref.environmentId)),
    learning: useAtomValue(deusEnvironment.getLearning.permissionAtom(ref.environmentId)),
    configure: useAtomValue(deusEnvironment.configureLearning.permissionAtom(ref.environmentId)),
    ponder: useAtomValue(deusEnvironment.ponder.permissionAtom(ref.environmentId)),
  };
  const taskAction = useAtomCommand(deusEnvironment.taskAction, { reportFailure: false });
  const reset = useAtomCommand(deusEnvironment.resetConversation, { reportFailure: false });
  const search = useAtomCommand(deusEnvironment.memorySearch, { reportFailure: false });
  const read = useAtomCommand(deusEnvironment.memoryRead, { reportFailure: false });
  const correct = useAtomCommand(deusEnvironment.memoryCorrect, { reportFailure: false });
  const getLearning = useAtomCommand(deusEnvironment.getLearning, { reportFailure: false });
  const configure = useAtomCommand(deusEnvironment.configureLearning, { reportFailure: false });
  const ponder = useAtomCommand(deusEnvironment.ponder, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<readonly DeusMemory[]>([]);
  const [evidence, setEvidence] = useState<DeusMemory | null>(null);
  const [selected, setSelected] = useState<DeusMemory | null>(null);
  const [correction, setCorrection] = useState("");
  const [learning, setLearning] = useState<DeusLearningStatus | null>(null);
  const pending = useRef<{ key: string; id: DeusInputId } | null>(null);
  const identity = (key: string) => {
    if (pending.current?.key !== key) pending.current = { key, id: DeusInputId.make(randomUUID()) };
    return pending.current.id;
  };
  const perform = async <A,>(
    operation: () => Promise<
      | { readonly _tag: "Success"; readonly value: A }
      | (Parameters<typeof squashAtomCommandFailure>[0] & { readonly _tag: "Failure" })
    >,
    success?: (value: A) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (result._tag === "Success") {
        success?.(result.value);
        pending.current = null;
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Deus action failed.");
      }
    } finally {
      setBusy(false);
    }
  };
  const act = (task: DeusTask, action: DeusTaskActionInput["action"]) =>
    void perform(
      () =>
        taskAction({
          environmentId: ref.environmentId,
          input: {
            ...ref,
            taskId: task.id,
            action,
            inputId: identity(JSON.stringify([task.id, action])),
            authority: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              allowWorktree: false,
            },
          },
        }),
      (result) => {
        setAnswer(result.answer);
      },
    );
  const sections = deusTaskSections(view);
  const card = (task: DeusTask) => {
    const root = task.workers.filter((worker) => worker.parentThreadId === null).at(-1);
    const active = task.status === "running" || task.status === "waiting";
    return (
      <li key={task.id} className="space-y-2 border-b border-border py-3">
        <p className="font-medium">
          {task.title} · {task.status}
        </p>
        {task.workers.map((worker) => (
          <div key={`${worker.threadId}:${worker.runId}`} className="space-y-1 text-xs">
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: ref.environmentId, threadId: worker.threadId }}
            >
              Open worker {worker.threadId}
            </Link>
            <p>
              {worker.model.instanceId} / {worker.model.model} ·{" "}
              {worker.model.options?.map((option) => `${option.id}=${option.value}`).join(", ") ||
                "provider defaults"}
            </p>
            <p>
              Run {worker.runId ?? "pending"} · {worker.status ?? task.status} · Pending
              approvals/requests: {worker.pendingApprovals ?? "unknown"}
            </p>
            <p>
              Parent: {worker.parentThreadId ?? "Deus"} / {worker.parentTaskId ?? task.id}
              {worker.previousRunId ? ` · Previous run: ${worker.previousRunId}` : ""}
            </p>
          </div>
        ))}
        {task.descendants?.map((child) => (
          <p key={child.id} className="text-xs">
            Child {child.id} · {child.origin} · {child.status}
            {child.childThreadId ? (
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: ref.environmentId, threadId: child.childThreadId }}
              >
                {" "}
                Open child thread
              </Link>
            ) : (
              " · native worker (no T3 thread)"
            )}
          </p>
        ))}
        {view.reports
          .filter((report) => report.taskId === task.id)
          .slice(-1)
          .map((report) => (
            <p key={report.cursor} className="whitespace-pre-wrap text-xs">
              {report.text}
            </p>
          ))}
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.task || !root || !direction.trim()}
            onClick={() => act(task, { type: "query", text: direction })}
          >
            Query snapshot
          </Button>
          <Button
            size="xs"
            variant="outline"
            title={!root?.operations?.steer ? "Provider steering unavailable" : undefined}
            disabled={
              busy || !allowed.task || !active || !root?.operations?.steer || !direction.trim()
            }
            onClick={() => act(task, { type: "steer", text: direction })}
          >
            Steer
          </Button>
          <Button
            size="xs"
            variant="outline"
            title={!root?.operations?.interrupt ? "Provider interruption unavailable" : undefined}
            disabled={busy || !allowed.task || !active || !root?.operations?.interrupt}
            onClick={() => act(task, { type: "interrupt" })}
          >
            Cancel run
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.task || !["failed", "cancelled"].includes(task.status)}
            onClick={() => act(task, { type: "retry" })}
          >
            Retry as new run
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.task || active || !direction.trim()}
            onClick={() => act(task, { type: "continue", text: direction })}
          >
            Continue
          </Button>
        </div>
      </li>
    );
  };
  return (
    <div className="max-h-96 shrink-0 overflow-y-auto border-b border-border px-4 py-2 text-sm">
      {sections.learningProblems.map((run) => (
        <p role="alert" key={run.id}>
          Learning {run.status}: {run.error ?? "Learning did not finish."}
        </p>
      ))}
      <details>
        <summary>Tasks, memory and learning · {sections.active.length} active</summary>
        {error ? <p role="alert">{error}</p> : null}
        <label>
          Task direction or snapshot question
          <Input
            value={direction}
            maxLength={8000}
            onChange={(event) => setDirection(event.target.value)}
          />
        </label>
        <ul aria-label="Active Deus tasks">{sections.active.map(card)}</ul>
        <details>
          <summary>Task history ({sections.history.length})</summary>
          <ul>{sections.history.map(card)}</ul>
        </details>
        {answer ? <p className="whitespace-pre-wrap">{answer}</p> : null}
        <section aria-label="Learning status" className="space-y-2 py-3">
          <h3 className="font-medium">Learning</h3>
          <p>
            {learning
              ? `${learning.enabled ? "Enabled" : "Disabled"} · ${learning.pendingCount} pending observations`
              : `${view.observations.length} working observations · load status for current pending count`}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.learning}
            onClick={() =>
              void perform(
                () => getLearning({ environmentId: ref.environmentId, input: ref }),
                setLearning,
              )
            }
          >
            Load learning status
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.configure || !learning}
            onClick={() =>
              void perform(
                () =>
                  configure({
                    environmentId: ref.environmentId,
                    input: { ...ref, enabled: !learning!.enabled },
                  }),
                setLearning,
              )
            }
          >
            {learning?.enabled ? "Disable learning" : "Enable learning"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.ponder}
            onClick={() =>
              void perform(() =>
                ponder({
                  environmentId: ref.environmentId,
                  input: {
                    ...ref,
                    inputId: identity(`ponder:${view.cursor}`),
                    snapshotCursor: view.cursor,
                  },
                }),
              )
            }
          >
            Run learning now
          </Button>
          <details>
            <summary>Learning history ({view.ponderReceipts.length})</summary>
            {[...view.ponderReceipts].reverse().map((run) => (
              <p key={run.id}>
                {run.status} · {run.createdAt} ·{" "}
                {run.counts?.consumed ?? run.acknowledgedObservationIds.length} consumed /{" "}
                {run.counts?.written ?? run.writtenMemoryIds.length} written · {run.error}
              </p>
            ))}
          </details>
        </section>
        <details>
          <summary>Working observations ({view.observations.length})</summary>
          {view.observations.map((item) => (
            <p key={item.id}>
              {item.kind} · {item.text} · source cursor {item.source?.cursor ?? "unknown"}
              {item.supersedes ? ` · corrects ${item.supersedes}` : ""}
            </p>
          ))}
        </details>
        <section aria-label="Long-term memory" className="space-y-2 py-3">
          <h3 className="font-medium">Long-term memory</h3>
          <Input
            aria-label="Search memory"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={1024}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !allowed.read}
            onClick={() =>
              void perform(
                () =>
                  search({ environmentId: ref.environmentId, input: { ...ref, query, limit: 20 } }),
                setMemories,
              )
            }
          >
            {query.trim() ? "Search memory" : "Load briefing"}
          </Button>
          {memories.map((item) => (
            <div key={item.id} className="space-y-1 border-b border-border py-2">
              <p>{item.text}</p>
              <p className="text-xs">
                {item.provenance?.scope} · revision {item.revision} · {item.provenance?.commit}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !allowed.evidence}
                onClick={() =>
                  void perform(
                    () =>
                      read({
                        environmentId: ref.environmentId,
                        input: { ...ref, memoryId: item.id, scope: item.provenance?.scope },
                      }),
                    setEvidence,
                  )
                }
              >
                Read evidence
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !allowed.correct || item.provenance?.scope !== "project"}
                onClick={() => {
                  setSelected(item);
                  setCorrection("");
                }}
              >
                Correct or remove
              </Button>
            </div>
          ))}
          {evidence ? (
            <div>
              <p className="whitespace-pre-wrap">{evidence.text}</p>
              {evidence.provenance?.sources.map((source) => (
                <p key={`${source.sessionId}:${source.cursor}`} className="text-xs">
                  Source {source.environmentId}/{source.projectId}/{source.sessionId} · cursor{" "}
                  {source.cursor}
                </p>
              ))}
            </div>
          ) : null}
          {selected ? (
            <div className="space-y-2" role="group" aria-label="Confirm memory correction">
              <p>
                Correct {selected.id}, revision {selected.revision}. Removal is destructive for
                retrieval; committed correction history is retained.
              </p>
              <Textarea
                aria-label="Memory correction"
                maxLength={16000}
                value={correction}
                onChange={(event) => setCorrection(event.target.value)}
              />
              <Button
                size="xs"
                variant={correction.trim() ? "outline" : "destructive"}
                disabled={busy || !allowed.correct}
                onClick={() =>
                  void perform(
                    () =>
                      correct({
                        environmentId: ref.environmentId,
                        input: {
                          ...ref,
                          memoryId: selected.id,
                          expectedRevision: selected.revision,
                          inputId: identity(JSON.stringify([selected.id, correction])),
                          correction: correction.trim() || null,
                        },
                      }),
                    () => {
                      setMemories((items) => items.filter((item) => item.id !== selected.id));
                      setEvidence(null);
                      setSelected(null);
                    },
                  )
                }
              >
                {correction.trim() ? "Save correction" : "Confirm remove memory"}
              </Button>
              <Button size="xs" variant="outline" onClick={() => setSelected(null)}>
                Keep memory
              </Button>
            </div>
          ) : null}
          <details>
            <summary>Correction history</summary>
            {view.memories
              .filter((item) => item.supersedes)
              .map((item) => (
                <p key={item.id}>
                  {item.updatedAt} · {item.supersedes} · {item.removedAt ? "Removed" : "Corrected"}{" "}
                  · {item.provenance?.commit}
                </p>
              ))}
          </details>
        </section>
        <p>Reset starts a new conversation. Workers keep running and memory is retained.</p>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !allowed.reset}
          onClick={() =>
            void perform(() =>
              reset({
                environmentId: ref.environmentId,
                input: { ...ref, inputId: identity(`reset:${ref.conversation}`) },
              }),
            )
          }
        >
          Start new conversation
        </Button>
      </details>
    </div>
  );
}
