import type { DeusScope, ScopedProjectRef } from "@t3tools/contracts";
import { PanelRightIcon, Volume2Icon } from "lucide-react";
import { useDeusPanelStore } from "../../deusPanelStore";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useDeusCommands } from "./DeusCommands";

function DestinationActions({ target }: { target: DeusScope }) {
  const actions = useDeusCommands(target);
  const { environments } = useEnvironments();
  const label =
    environments.find((item) => item.environmentId === target.environmentId)?.label ??
    target.environmentId;
  return (
    <>
      {actions.map((action) => (
        <MenuItem key={action.command} disabled={!action.enabled} onClick={action.run}>
          {label} · {action.title}
        </MenuItem>
      ))}
    </>
  );
}
function SingleEntry({
  target,
  navigateToProject,
}: {
  target: DeusScope;
  navigateToProject: boolean;
}) {
  const open = useDeusCommands(target)[0]!;
  return (
    <span className="inline-flex">
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Open project Deus"
        title="Open project Deus"
        data-right-panel-toggle
        disabled={!open.enabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (navigateToProject) open.run();
          else useDeusPanelStore.getState().requestOpen(target);
        }}
      >
        <PanelRightIcon className="size-3.5" />
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Project Deus actions"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Volume2Icon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup>
          <DestinationActions target={target} />
        </MenuPopup>
      </Menu>
    </span>
  );
}
export function ProjectDeusEntry({
  projectRefs,
  navigateToProject = true,
}: {
  projectRefs: readonly ScopedProjectRef[];
  navigateToProject?: boolean;
}) {
  if (projectRefs.length === 1)
    return <SingleEntry target={projectRefs[0]!} navigateToProject={navigateToProject} />;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Open project Deus"
            title="Open project Deus"
            data-right-panel-toggle
            onPointerDown={(event) => event.stopPropagation()}
          >
            <PanelRightIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup>
        {projectRefs.map((target) => (
          <DestinationActions key={`${target.environmentId}:${target.projectId}`} target={target} />
        ))}
      </MenuPopup>
    </Menu>
  );
}
