import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { deusTaskSections, type DeusConversationView } from "@t3tools/client-runtime/state/deus";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DeusInputId,
  type DeusLearningStatus,
  type DeusMemory,
  type DeusTaskActionInput,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { deusEnvironment } from "../../state/deus";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDeusPanelStore } from "./panelStore";

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-xl border border-border px-3 py-2 ${disabled ? "opacity-40" : "active:opacity-70"}`}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}
export function DeusDetails({ view }: { view: DeusConversationView }) {
  const ref = view.session;
  const navigation = useNavigation();
  const allowed = {
    task: useAtomValue(deusEnvironment.taskAction.permissionAtom(ref.environmentId)),
    reset: useAtomValue(deusEnvironment.resetConversation.permissionAtom(ref.environmentId)),
    memory: useAtomValue(deusEnvironment.memorySearch.permissionAtom(ref.environmentId)),
    evidence: useAtomValue(deusEnvironment.memoryRead.permissionAtom(ref.environmentId)),
    correct: useAtomValue(deusEnvironment.memoryCorrect.permissionAtom(ref.environmentId)),
    learning: useAtomValue(deusEnvironment.getLearning.permissionAtom(ref.environmentId)),
    configure: useAtomValue(deusEnvironment.configureLearning.permissionAtom(ref.environmentId)),
    ponder: useAtomValue(deusEnvironment.ponder.permissionAtom(ref.environmentId)),
  };
  const task = useAtomCommand(deusEnvironment.taskAction, { reportFailure: false });
  const reset = useAtomCommand(deusEnvironment.resetConversation, { reportFailure: false });
  const search = useAtomCommand(deusEnvironment.memorySearch, { reportFailure: false });
  const read = useAtomCommand(deusEnvironment.memoryRead, { reportFailure: false });
  const correct = useAtomCommand(deusEnvironment.memoryCorrect, { reportFailure: false });
  const getLearning = useAtomCommand(deusEnvironment.getLearning, { reportFailure: false });
  const configure = useAtomCommand(deusEnvironment.configureLearning, { reportFailure: false });
  const ponder = useAtomCommand(deusEnvironment.ponder, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState(false);
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
  const visit = async (threadId: ThreadId) => {
    if (await useDeusPanelStore.getState().visitWorker())
      navigation.dispatch(
        StackActions.push("Thread", { environmentId: ref.environmentId, threadId }),
      );
  };
  const act = (taskId: DeusTaskActionInput["taskId"], action: DeusTaskActionInput["action"]) =>
    void perform(
      () =>
        task({
          environmentId: ref.environmentId,
          input: {
            ...ref,
            taskId,
            action,
            inputId: identity(JSON.stringify([taskId, action])),
            authority: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              allowWorktree: false,
            },
          },
        }),
      (result) => setAnswer(result.answer),
    );
  const sections = deusTaskSections(view);
  return (
    <View className="gap-2 border-b border-border p-4">
      <Action
        label={`${expanded ? "Hide" : "Show"} tasks, memory and learning · ${sections.active.length} active`}
        onPress={() => setExpanded(!expanded)}
      />
      {sections.learningProblems.map((run) => (
        <Text key={run.id} accessibilityRole="alert">
          Learning {run.status}: {run.error}
        </Text>
      ))}
      {expanded ? (
        <ScrollView className="max-h-96" contentContainerClassName="gap-2">
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          <TextInput
            accessibilityLabel="Task direction or snapshot question"
            className="min-h-11 rounded-xl border border-border p-3 text-foreground"
            maxLength={8000}
            value={direction}
            onChangeText={setDirection}
          />
          {[...sections.active, ...(history ? sections.history : [])].map((item) => {
            const root = item.workers.filter((worker) => worker.parentThreadId === null).at(-1);
            const active = item.status === "running" || item.status === "waiting";
            return (
              <View key={item.id} className="gap-2 border-b border-border py-2">
                <Text>
                  {item.title} · {item.status}
                </Text>
                {item.workers.map((worker) => (
                  <View key={`${worker.threadId}:${worker.runId}`}>
                    <Action
                      label={`Open worker ${worker.threadId}`}
                      onPress={() => void visit(worker.threadId)}
                    />
                    <Text>
                      {worker.model.instanceId} / {worker.model.model} ·{" "}
                      {worker.model.options
                        ?.map((option) => `${option.id}=${option.value}`)
                        .join(", ") || "provider defaults"}
                    </Text>
                    <Text>
                      Run {worker.runId} · {worker.status ?? item.status} ·{" "}
                      {worker.pendingApprovals ?? "unknown"} pending approvals/requests
                    </Text>
                    <Text>
                      Parent {worker.parentThreadId ?? "Deus"} / {worker.parentTaskId ?? item.id} ·
                      previous run {worker.previousRunId ?? "none"}
                    </Text>
                  </View>
                ))}
                {item.descendants?.map((child) => (
                  <View key={child.id}>
                    <Text>
                      Child {child.id} · {child.origin} · {child.status}
                    </Text>
                    {child.childThreadId ? (
                      <Action
                        label="Open child thread"
                        onPress={() => void visit(child.childThreadId!)}
                      />
                    ) : (
                      <Text>No T3 thread for native worker</Text>
                    )}
                  </View>
                ))}
                {view.reports
                  .filter((report) => report.taskId === item.id)
                  .slice(-1)
                  .map((report) => (
                    <Text key={report.cursor}>{report.text}</Text>
                  ))}
                <Action
                  label="Query snapshot"
                  disabled={busy || !allowed.task || !direction.trim()}
                  onPress={() => act(item.id, { type: "query", text: direction })}
                />
                <Action
                  label={root?.operations?.steer ? "Steer" : "Steer unavailable for provider"}
                  disabled={
                    busy ||
                    !allowed.task ||
                    !active ||
                    !root?.operations?.steer ||
                    !direction.trim()
                  }
                  onPress={() => act(item.id, { type: "steer", text: direction })}
                />
                <Action
                  label={
                    root?.operations?.interrupt ? "Cancel run" : "Cancel unavailable for provider"
                  }
                  disabled={busy || !allowed.task || !active || !root?.operations?.interrupt}
                  onPress={() => act(item.id, { type: "interrupt" })}
                />
                <Action
                  label="Retry as new run"
                  disabled={busy || !allowed.task || !["failed", "cancelled"].includes(item.status)}
                  onPress={() => act(item.id, { type: "retry" })}
                />
                <Action
                  label="Continue"
                  disabled={busy || !allowed.task || active || !direction.trim()}
                  onPress={() => act(item.id, { type: "continue", text: direction })}
                />
              </View>
            );
          })}
          <Action
            label={`${history ? "Hide" : "Show"} task history (${sections.history.length})`}
            onPress={() => setHistory(!history)}
          />
          {answer ? <Text selectable>{answer}</Text> : null}
          <Text>
            Learning ·{" "}
            {learning
              ? `${learning.enabled ? "Enabled" : "Disabled"} · ${learning.pendingCount} pending observations`
              : `${view.observations.length} working observations`}
          </Text>
          <Action
            label="Load learning status"
            disabled={busy || !allowed.learning}
            onPress={() =>
              void perform(
                () => getLearning({ environmentId: ref.environmentId, input: ref }),
                setLearning,
              )
            }
          />
          <Action
            label={learning?.enabled ? "Disable learning" : "Enable learning"}
            disabled={busy || !allowed.configure || !learning}
            onPress={() =>
              void perform(
                () =>
                  configure({
                    environmentId: ref.environmentId,
                    input: { ...ref, enabled: !learning!.enabled },
                  }),
                setLearning,
              )
            }
          />
          <Action
            label="Run learning now"
            disabled={busy || !allowed.ponder}
            onPress={() =>
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
          />
          {view.ponderReceipts.map((run) => (
            <Text key={run.id}>
              {run.createdAt} · {run.status} ·{" "}
              {run.counts?.consumed ?? run.acknowledgedObservationIds.length} consumed /{" "}
              {run.counts?.written ?? run.writtenMemoryIds.length} written · {run.error}
            </Text>
          ))}
          <Text>Working observations</Text>
          {view.observations.map((observation) => (
            <Text key={observation.id}>
              {observation.kind} · {observation.text} · source {observation.source?.cursor}
            </Text>
          ))}
          <TextInput
            accessibilityLabel="Search memory"
            className="min-h-11 rounded-xl border border-border p-3 text-foreground"
            value={query}
            onChangeText={setQuery}
            maxLength={1024}
          />
          <Action
            label={query.trim() ? "Search memory" : "Load briefing"}
            disabled={busy || !allowed.memory}
            onPress={() =>
              void perform(
                () =>
                  search({ environmentId: ref.environmentId, input: { ...ref, query, limit: 20 } }),
                setMemories,
              )
            }
          />
          {memories.map((memory) => (
            <View key={memory.id} className="gap-2">
              <Text>{memory.text}</Text>
              <Text>
                {memory.provenance?.scope} · revision {memory.revision} ·{" "}
                {memory.provenance?.commit}
              </Text>
              <Action
                label="Read evidence"
                disabled={busy || !allowed.evidence}
                onPress={() =>
                  void perform(
                    () =>
                      read({
                        environmentId: ref.environmentId,
                        input: { ...ref, memoryId: memory.id, scope: memory.provenance?.scope },
                      }),
                    setEvidence,
                  )
                }
              />
              <Action
                label="Correct or remove memory"
                disabled={busy || !allowed.correct || memory.provenance?.scope !== "project"}
                onPress={() => {
                  setSelected(memory);
                  setCorrection("");
                }}
              />
            </View>
          ))}
          {evidence ? (
            <>
              <Text selectable>{evidence.text}</Text>
              {evidence.provenance?.sources.map((source) => (
                <Text key={`${source.sessionId}:${source.cursor}`}>
                  {source.environmentId}/{source.projectId}/{source.sessionId} · cursor{" "}
                  {source.cursor}
                </Text>
              ))}
            </>
          ) : null}
          {selected ? (
            <>
              <Text>
                Correct {selected.id}, revision {selected.revision}. Removal is destructive for
                retrieval; correction history is retained.
              </Text>
              <TextInput
                accessibilityLabel="Memory correction"
                value={correction}
                onChangeText={setCorrection}
                maxLength={16000}
                multiline
                className="min-h-11 rounded-xl border border-border p-3 text-foreground"
              />
              <Action
                label={correction.trim() ? "Save correction" : "Confirm remove memory"}
                disabled={busy || !allowed.correct}
                onPress={() =>
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
              />
              <Action label="Keep memory" onPress={() => setSelected(null)} />
            </>
          ) : null}
          {view.memories
            .filter((memory) => memory.supersedes)
            .map((memory) => (
              <Text key={memory.id}>
                Correction {memory.updatedAt} · {memory.supersedes} ·{" "}
                {memory.removedAt ? "Removed" : "Corrected"} · {memory.provenance?.commit}
              </Text>
            ))}
          <Text>Reset starts a new conversation. Workers keep running and memory is retained.</Text>
          <Action
            label="Start new conversation"
            disabled={busy || !allowed.reset}
            onPress={() =>
              void perform(() =>
                reset({
                  environmentId: ref.environmentId,
                  input: { ...ref, inputId: identity(`reset:${ref.conversation}`) },
                }),
              )
            }
          />
        </ScrollView>
      ) : null}
    </View>
  );
}
