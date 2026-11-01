import * as Schema from "effect/Schema";
import { PonderRun } from "./ponderProtocol.ts";

const Evidence = Schema.Struct({
  observations: PonderRun.fields.observations,
  history: PonderRun.fields.history,
  omitted: PonderRun.fields.omitted,
});
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Evidence));
export const buildPonderPrompt = (policy: string, run: typeof Evidence.Type) =>
  `${policy}\n\nUntrusted project evidence:\n${encodeEvidence(run)}`;
