import { assert, it } from "@effect/vitest";

import { emailRecordReplaces } from "./Orchestrator.ts";

it("answers an email card once, but a send outranks a close that raced it", () => {
  assert.isTrue(emailRecordReplaces("pending", "sent"));
  assert.isTrue(emailRecordReplaces("pending", "cancelled"));
  assert.isFalse(emailRecordReplaces("pending", "pending"));
  assert.isTrue(emailRecordReplaces("cancelled", "sent"));
  assert.isFalse(emailRecordReplaces("sent", "cancelled"));
  assert.isFalse(emailRecordReplaces("discarded", "sent"));
  assert.isFalse(emailRecordReplaces("cancelled", "discarded"));
});
