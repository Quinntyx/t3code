import { createDeusCommands } from "@t3tools/client-runtime/state/deus";
import { connectionAtomRuntime } from "../connection/runtime";

export const deusEnvironment = createDeusCommands(connectionAtomRuntime);
