import { describe, expect, it } from "vite-plus/test";

import { emailRequestDisplay, parseAddressList } from "./emailRequest.ts";

describe("parseAddressList", () => {
  it("keeps commas inside quoted names and angle brackets", () => {
    expect(
      parseAddressList('"Lovelace, Ada" <ada@example.com>, bob@example.com;\ncarol@example.com,,'),
    ).toEqual(['"Lovelace, Ada" <ada@example.com>', "bob@example.com", "carol@example.com"]);
    expect(parseAddressList("  ")).toEqual([]);
  });
});

describe("emailRequestDisplay", () => {
  const draft = {
    account: "school",
    to: ['"Lovelace, Ada" <ada@example.com>', "bob@example.com"],
    cc: [],
    bcc: [],
    subject: "Office hours",
    body: "",
  };

  it("never offers the composer for a draft inherited from another thread", () => {
    expect(emailRequestDisplay({ emailStatus: "pending", draft }, "inherited").kind).toBe(
      "pending-elsewhere",
    );
  });

  it("names who the email went to", () => {
    expect(emailRequestDisplay({ emailStatus: "sent", draft }, "local")).toEqual({
      kind: "answered",
      outcome: "sent",
      label: "Sent “Office hours” to Lovelace, Ada and 1 more",
    });
  });
});
