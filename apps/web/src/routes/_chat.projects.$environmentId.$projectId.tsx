import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectLanding } from "../components/deus/ProjectLanding";

export const Route = createFileRoute("/_chat/projects/$environmentId/$projectId")({
  component: ProjectRoute,
});

function ProjectRoute() {
  const params = Route.useParams();
  return (
    <ProjectLanding
      target={scopeProjectRef(
        EnvironmentId.make(params.environmentId),
        ProjectId.make(params.projectId),
      )}
    />
  );
}
