import { useAtomValue } from "@effect/atom-react";
import { WifiOffIcon } from "lucide-react";

import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

/**
 * The one failure the environments cannot report: this device, not the server
 * behind it, is what is unreachable. It clears itself when the network answers.
 */
export function OfflineBanner() {
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  if (networkStatus !== "offline") {
    return null;
  }

  // A retry also re-checks the network, so it is the way out of a wrong verdict.
  const retryAll = () => {
    for (const [environmentId, entry] of catalog.entries) {
      if (entry.enabled) void retryEnvironment(environmentId);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-100 flex justify-center px-3 pt-3">
      <Alert
        className="pointer-events-auto w-full max-w-md"
        controlAlignment="first-line"
        surface="glass"
        variant="error"
      >
        <WifiOffIcon />
        <AlertTitle>You are offline</AlertTitle>
        <AlertDescription>
          Environments reconnect as soon as this device reaches the network.
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="ghost" onClick={retryAll}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
