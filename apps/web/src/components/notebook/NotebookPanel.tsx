/* oxlint-disable react/no-array-index-key -- Snapshot outputs have no IDs; ordinals identify them within a cell. */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  PycellsNotebookCell,
  PycellsNotebookKernel,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSyncExternalStore } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useNotebookStore } from "./notebookStore";

const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};
const documentVisible = () => document.visibilityState === "visible";

export default function NotebookPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => false);
  return visible ? <NotebookContent threadRef={threadRef} /> : null;
}

function NotebookContent({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    serverEnvironment.threadNotebook({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const view = useNotebookStore((state) => state.byThread[scopedThreadKey(threadRef)]);
  const kernels = query.data?.kernels ?? [];
  const kernel = kernels.find((entry) => entry.id === view?.kernelId) ?? kernels[0];
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Notebook">
      {kernel ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{kernel.name}</div>
            <div className="truncate text-xs text-muted-foreground">{kernel.notebookPath}</div>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {kernel.running ? "Running" : "Idle"}
          </span>
          {kernels.length > 1 ? (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost-muted" size="xs" aria-label="Select kernel" />}
              >
                Kernel <ChevronDown className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end">
                {kernels.map((entry) => (
                  <MenuItem
                    key={entry.id}
                    onClick={() => useNotebookStore.getState().selectKernel(threadRef, entry.id)}
                  >
                    {entry.name}
                    {entry.id === kernel.id ? " ✓" : ""}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </header>
      ) : null}
      {query.error ? (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">Could not load notebook. {query.error}</span>
          <Button variant="ghost" size="xs" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {!kernel ? (
        <p role="status" className="p-4 text-center text-sm text-muted-foreground">
          {query.isPending
            ? "Loading notebook…"
            : query.error
              ? "Notebook unavailable."
              : "No notebook cells yet."}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {kernel.cells.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No cells in this kernel yet.
            </p>
          ) : (
            kernel.cells.map((cell) => (
              <NotebookCell
                key={JSON.stringify([kernel.id, cell.id])}
                cell={cell}
                kernel={kernel}
                threadRef={threadRef}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function NotebookCell({
  cell,
  kernel,
  threadRef,
}: {
  cell: PycellsNotebookCell;
  kernel: PycellsNotebookKernel;
  threadRef: ScopedThreadRef;
}) {
  const collapsed = useNotebookStore(
    (state) => state.byThread[scopedThreadKey(threadRef)]?.collapsed,
  );
  const key = (part: string) => JSON.stringify([kernel.id, cell.id, part]);
  const isCollapsed = (part: string) => collapsed?.[key(part)] ?? false;
  const toggle = (part: string) => useNotebookStore.getState().toggle(threadRef, key(part));
  const count = cell.executionCount ?? " ";
  return (
    <article className="mb-3 rounded-md border border-border">
      <button
        type="button"
        aria-expanded={!isCollapsed("cell")}
        onClick={() => toggle("cell")}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        {isCollapsed("cell") ? (
          <ChevronRight className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
        <span>Cell {cell.index}</span>
        <span className="ml-auto">{cell.cellType}</span>
      </button>
      {!isCollapsed("cell") ? (
        <>
          <div className="flex items-start gap-2 px-2 pb-2">
            <button
              type="button"
              aria-label={`Toggle source for cell ${cell.index}`}
              aria-expanded={!isCollapsed("source")}
              onClick={() => toggle("source")}
              className="flex w-20 shrink-0 items-center gap-1 pt-2 font-mono text-xs text-info focus-visible:outline-2 focus-visible:outline-ring"
            >
              {isCollapsed("source") ? (
                <ChevronRight className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
              {cell.cellType === "code" ? `In [${count}]:` : "Source"}
            </button>
            <div className="min-w-0 flex-1">
              {isCollapsed("source") ? (
                <span className="text-xs text-muted-foreground">Source collapsed</span>
              ) : cell.cellType === "markdown" ? (
                <ChatMarkdown
                  text={cell.source}
                  cwd={undefined}
                  threadRef={threadRef}
                  parseRawHtml={false}
                />
              ) : (
                <pre className="overflow-x-auto rounded-sm bg-muted/40 p-2 font-mono text-xs leading-relaxed">
                  <code>{cell.source || " "}</code>
                </pre>
              )}
            </div>
          </div>
          {cell.outputs.length > 0 ? (
            <div className="flex items-start gap-2 border-t border-border px-2 py-2">
              <button
                type="button"
                aria-label={`Toggle outputs for cell ${cell.index}`}
                aria-expanded={!isCollapsed("outputs")}
                onClick={() => toggle("outputs")}
                className="flex w-20 shrink-0 items-center gap-1 font-mono text-xs text-warning focus-visible:outline-2 focus-visible:outline-ring"
              >
                {isCollapsed("outputs") ? (
                  <ChevronRight className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                {`Out[${count}]:`}
              </button>
              <div className="min-w-0 flex-1 space-y-2">
                {isCollapsed("outputs") ? (
                  <span className="text-xs text-muted-foreground">
                    {cell.outputs.length} outputs collapsed
                  </span>
                ) : (
                  cell.outputs.map((output, index) =>
                    output.kind === "image" ? (
                      <img
                        key={index}
                        src={`data:${output.mimeType};base64,${output.data}`}
                        alt={`Cell ${cell.index} output ${index + 1}`}
                        className="h-auto max-w-full"
                        loading="lazy"
                      />
                    ) : (
                      <pre
                        key={index}
                        className={`overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed ${output.kind === "error" ? "text-destructive" : "text-foreground"}`}
                      >
                        {output.text}
                      </pre>
                    ),
                  )
                )}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
