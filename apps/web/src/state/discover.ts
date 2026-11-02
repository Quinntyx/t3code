import { createDiscoveryAtoms, createDiscoveryHostAtoms } from "@t3tools/client-runtime/discover";

import { connectionAtomRuntime } from "../connection/runtime";

export const directoryDiscovery = createDiscoveryAtoms(connectionAtomRuntime);
export const discoveryHost = createDiscoveryHostAtoms(connectionAtomRuntime);
