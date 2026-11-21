import { createDiscoveryAtoms } from "@t3tools/client-runtime/discover";

import { connectionAtomRuntime } from "../connection/runtime";

export const directoryDiscovery = createDiscoveryAtoms(connectionAtomRuntime);
