import { assert, it } from "@effect/vitest";

import { findAercAccount, parseAercAccounts, parseAercOutgoing } from "./aercAccounts.ts";

const ACCOUNTS_CONF = `
# personal
[school]
source = notmuch://
outgoing = smtp+xoauth2://ada%40school.edu@smtp-mail.outlook.com:587
outgoing-cred-cmd = oama access ada@school.edu
from = "Lovelace, Ada" <ada@school.edu>

[gmail]
outgoing = smtps+plain://ada%40gmail.com:app%20pass@smtp.gmail.com
from = Ada <ada@gmail.com>

[local]
outgoing = /usr/bin/msmtp --account=local
from = ada@localhost

[read-only]
source = imaps://imap.example.com
from = ada@example.com
`;

it("reads sending accounts in aerc's tab order and skips ones that cannot send", () => {
  const accounts = parseAercAccounts(ACCOUNTS_CONF);
  assert.deepEqual(
    accounts.map(({ name, from, outgoingCredCmd }) => ({
      name,
      from,
      outgoingCredCmd,
    })),
    [
      {
        name: "school",
        from: '"Lovelace, Ada" <ada@school.edu>',
        outgoingCredCmd: "oama access ada@school.edu",
      },
      {
        name: "gmail",
        from: "Ada <ada@gmail.com>",
        outgoingCredCmd: undefined,
      },
      { name: "local", from: "ada@localhost", outgoingCredCmd: undefined },
    ],
  );
});

it("translates aerc's outgoing forms into a transport", () => {
  const [school, gmail, local] = parseAercAccounts(ACCOUNTS_CONF);
  assert.deepEqual(parseAercOutgoing(school!.outgoing), {
    kind: "smtp",
    host: "smtp-mail.outlook.com",
    port: 587,
    tls: "starttls",
    auth: "xoauth2",
    user: "ada@school.edu",
    password: undefined,
  });
  assert.deepEqual(parseAercOutgoing(gmail!.outgoing), {
    kind: "smtp",
    host: "smtp.gmail.com",
    port: 465,
    tls: "implicit",
    auth: "plain",
    user: "ada@gmail.com",
    password: "app pass",
  });
  assert.deepEqual(parseAercOutgoing(local!.outgoing), {
    kind: "sendmail",
    command: "/usr/bin/msmtp",
    args: ["--account=local"],
  });
  assert.deepEqual(parseAercOutgoing("smtp+insecure://relay.lan:25"), {
    kind: "smtp",
    host: "relay.lan",
    port: 25,
    tls: "none",
    auth: "plain",
    user: undefined,
    password: undefined,
  });
  assert.deepEqual(parseAercOutgoing("jmap://mail.example.com"), {
    kind: "unsupported",
    scheme: "jmap",
  });
  assert.deepEqual(
    parseAercOutgoing(
      "smtp+xoauth2://ada@smtp.example.com?token_endpoint=https://login.example.com/token",
    ),
    { kind: "unsupported", scheme: "xoauth2 with token_endpoint" },
  );
  assert.deepEqual(parseAercOutgoing("smtp+cram-md5://mail.example.com"), {
    kind: "unsupported",
    scheme: "smtp+cram-md5",
  });
});

it("finds an account by name or by its address", () => {
  const accounts = parseAercAccounts(ACCOUNTS_CONF);
  assert.equal(findAercAccount(accounts, "GMAIL")?.name, "gmail");
  assert.equal(findAercAccount(accounts, "ada@school.edu")?.name, "school");
  assert.equal(findAercAccount(accounts, "Someone <ADA@gmail.com>")?.name, "gmail");
  assert.isUndefined(findAercAccount(accounts, "ada@elsewhere.org"));
});
