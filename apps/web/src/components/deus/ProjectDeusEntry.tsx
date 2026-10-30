import type { ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PanelRightIcon } from "lucide-react";
import { useDeusPanelStore } from "../../deusPanelStore";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function ProjectDeusEntry({
  projectRefs,
  navigateToProject = true,
}: {
  projectRefs: readonly ScopedProjectRef[];
  navigateToProject?: boolean;
}) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const open = (ref: ScopedProjectRef) => {
    useDeusPanelStore.getState().requestOpen(ref);
    if (navigateToProject)
      void navigate({ to: "/projects/$environmentId/$projectId", params: ref });
  };
  const trigger = (
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
  );
  if (projectRefs.length === 1)
    return (
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Open project Deus"
        title="Open project Deus"
        data-right-panel-toggle
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          open(projectRefs[0]!);
        }}
      >
        <PanelRightIcon className="size-3.5" />
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger render={trigger} />
      <MenuPopup>
        {projectRefs.map((ref) => (
          <MenuItem key={`${ref.environmentId}:${ref.projectId}`} onClick={() => open(ref)}>
            {environments.find((env) => env.environmentId === ref.environmentId)?.label ??
              ref.environmentId}{" "}
            · {ref.environmentId} / {ref.projectId}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
