import { type DeusScope } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useProject } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useDeusPanelStore } from "../../deusPanelStore";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";

export function ProjectLanding({ target }: { target: DeusScope }) {
  const project = useProject(scopeProjectRef(target.environmentId, target.projectId));
  const environment = useEnvironment(target.environmentId);
  return (
    <SidebarInset className="h-dvh">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <SidebarTrigger />
        <span className="text-sm font-medium">{project?.title ?? "Project"}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-4 p-8">
        <h1 className="text-xl font-medium">{project?.title ?? "Project unavailable"}</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          Coordinate this project with Deus. No worker thread is needed to open the project
          conversation.
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {environment?.label ?? "Unavailable environment"} · {target.environmentId} /{" "}
          {target.projectId}
        </p>
        <Button
          data-right-panel-toggle
          onClick={() => useDeusPanelStore.getState().requestOpen(target)}
          disabled={!project || !environment}
        >
          Open Deus
        </Button>
      </div>
    </SidebarInset>
  );
}
