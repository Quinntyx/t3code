import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { emailConnector } from "./handlers.ts";

const thread = {
  threadId: ThreadId.make("thread-email-connector"),
  providerSessionId: "provider-session-email-connector",
  providerInstanceId: ProviderInstanceId.make("codex"),
};

it("hides compose_email from outside clients, which cannot act as a thread", () => {
  expect(emailConnector({ thread: undefined, email: true })).toMatchObject({
    enabled: false,
    tools: [],
  });
});

it("offers compose_email to a thread's agent while drafts are on", () => {
  expect(emailConnector({ thread, email: true })).toMatchObject({
    enabled: true,
    tools: ["compose_email"],
  });
  expect(emailConnector({ thread, email: false })).toMatchObject({
    enabled: false,
    tools: [],
  });
});
