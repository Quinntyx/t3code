import { useAtomValue } from "@effect/atom-react";
import { WifiOffIcon } from "lucide-react";

import { environmentCatalog } from "../connection/catalog";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

/**
 * The one failure the environments cannot report: this device, not the server
 * behind it, is what is unreachable. It clears itself when the network answers.
 */
export function OfflineBanner() {
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  if (networkStatus !== "offline") {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-100 flex justify-center px-3 pt-3">
      <Alert
        className="w-full max-w-md"
        controlAlignment="first-line"
        surface="glass"
        variant="error"
      >
        <WifiOffIcon />
        <AlertTitle>You are offline</AlertTitle>
        <AlertDescription>
          Environments reconnect as soon as this device reaches the network.
        </AlertDescription>
      </Alert>
    </div>
  );
}
