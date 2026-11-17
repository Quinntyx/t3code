import type { RegisteredMcpServerState } from "@t3tools/contracts";

import { Badge } from "../ui/badge";

/** One registered server's runtime status, shown wherever an entry's health is listed. */
export function McpServerStatusBadge({
  status,
}: {
  readonly status: RegisteredMcpServerState["status"];
}) {
  switch (status) {
    case "running":
      return <Badge variant="success">Running</Badge>;
    case "starting":
      return <Badge variant="info">Starting</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    case "stopped":
      return <Badge variant="outline">Stopped</Badge>;
  }
}
