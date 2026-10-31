// Reads sending accounts from aerc's accounts.conf so T3 Code sends mail the way the user's own
// mail client does, without a mail setup of its own.
import type { EmailAccountStatus } from "@t3tools/contracts";

export interface AercAccount {
  readonly name: string;
  readonly from: string;
  readonly outgoing: string;
  readonly outgoingCredCmd: string | undefined;
}

export type AercOutgoing =
  | {
      readonly kind: "smtp";
      readonly host: string;
      readonly port: number;
      readonly tls: "implicit" | "starttls" | "none";
      readonly auth: "plain" | "login" | "xoauth2" | "none";
      readonly user: string | undefined;
      readonly password: string | undefined;
    }
  | {
      readonly kind: "sendmail";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }
  | { readonly kind: "unsupported"; readonly scheme: string };

const unquote = (value: string) => {
  const quoted = /^"([^"]*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
  return quoted?.[1] ?? value;
};

interface AercSection {
  readonly name: string;
  readonly from: string | undefined;
  readonly outgoing: string | undefined;
  readonly outgoingCredCmd: string | undefined;
}

/** Every account section in file order, which is aerc's tab order. */
function parseAercSections(text: string): ReadonlyArray<AercSection> {
  const sections: Array<{ name: string; values: Map<string, string> }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section?.[1] !== undefined) {
      sections.push({ name: section[1].trim(), values: new Map() });
      continue;
    }
    const separator = line.indexOf("=");
    const current = sections.at(-1);
    if (separator <= 0 || current === undefined) continue;
    current.values.set(
      line.slice(0, separator).trim().toLowerCase(),
      unquote(line.slice(separator + 1).trim()),
    );
  }
  return sections.map(({ name, values }) => ({
    name,
    from: values.get("from") || undefined,
    outgoing: values.get("outgoing") || undefined,
    outgoingCredCmd: values.get("outgoing-cred-cmd") || undefined,
  }));
}

/** Accounts in aerc's tab order. Accounts without a From address or `outgoing` are left out. */
export function parseAercAccounts(text: string): ReadonlyArray<AercAccount> {
  return parseAercSections(text).flatMap(({ name, from, outgoing, outgoingCredCmd }) =>
    from === undefined || outgoing === undefined ? [] : [{ name, from, outgoing, outgoingCredCmd }],
  );
}

const SMTP_LOGIN = {
  xoauth2: "OAuth2 token",
  plain: "password",
  login: "password (LOGIN)",
} as const;

/** How each account sends, or why it can't, without revealing a password. */
export function describeAercAccounts(text: string): ReadonlyArray<EmailAccountStatus> {
  return parseAercSections(text).map(({ name, from, outgoing, outgoingCredCmd }) => {
    const account = { name, ...(from === undefined ? {} : { from }) };
    if (from === undefined) return { ...account, problem: "No from address." };
    if (outgoing === undefined) return { ...account, problem: "No outgoing setting." };
    const parsed = parseAercOutgoing(outgoing);
    switch (parsed.kind) {
      case "unsupported":
        return {
          ...account,
          problem: `T3 Code can't send with ${parsed.scheme ? `"${parsed.scheme}"` : "this outgoing setting"}.`,
        };
      case "sendmail":
        return { ...account, sending: `Command: ${parsed.command}` };
      case "smtp": {
        const login =
          parsed.auth === "none" || (parsed.user === undefined && outgoingCredCmd === undefined)
            ? "no login"
            : `${SMTP_LOGIN[parsed.auth]} ${outgoingCredCmd === undefined ? "in the URL" : "from outgoing-cred-cmd"}`;
        const security = parsed.tls === "none" ? " · no TLS" : "";
        return { ...account, sending: `SMTP ${parsed.host}:${parsed.port} · ${login}${security}` };
      }
    }
  });
}

/** Follows aerc's `outgoing` forms: `smtp[s][+auth][+insecure]://` URLs or a sendmail command. */
export function parseAercOutgoing(outgoing: string): AercOutgoing {
  if (!outgoing.includes("://")) {
    const [command, ...args] = outgoing.split(/\s+/).filter((part) => part !== "");
    return command === undefined
      ? { kind: "unsupported", scheme: "" }
      : { kind: "sendmail", command, args };
  }
  let url: URL;
  try {
    url = new URL(outgoing);
  } catch {
    return { kind: "unsupported", scheme: outgoing.split("://")[0] ?? "" };
  }
  const [protocol = "", ...modifiers] = url.protocol.replace(/:$/, "").split("+");
  if (protocol !== "smtp" && protocol !== "smtps") {
    return { kind: "unsupported", scheme: url.protocol.replace(/:$/, "") };
  }
  const insecure = modifiers.includes("insecure");
  const mechanisms = modifiers.filter((modifier) => modifier !== "insecure");
  const mechanism = mechanisms[0] ?? "plain";
  if (
    mechanisms.length > 1 ||
    (mechanism !== "plain" &&
      mechanism !== "login" &&
      mechanism !== "xoauth2" &&
      mechanism !== "none")
  ) {
    return { kind: "unsupported", scheme: url.protocol.replace(/:$/, "") };
  }
  // With a token endpoint aerc holds a refresh token and exchanges it itself; T3 Code does not.
  if (mechanism === "xoauth2" && url.searchParams.has("token_endpoint")) {
    return { kind: "unsupported", scheme: "xoauth2 with token_endpoint" };
  }
  const implicit = protocol === "smtps";
  return {
    kind: "smtp",
    host: url.hostname,
    port: url.port === "" ? (implicit ? 465 : 587) : Number(url.port),
    tls: implicit ? "implicit" : insecure ? "none" : "starttls",
    auth: mechanism,
    user: url.username === "" ? undefined : decodeURIComponent(url.username),
    password: url.password === "" ? undefined : decodeURIComponent(url.password),
  };
}

/** The bare address in a From header such as `"Ada" <ada@example.com>`. */
const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();

/** Matches an account by name or address, ignoring case. */
export function findAercAccount<A extends Pick<AercAccount, "name" | "from">>(
  accounts: ReadonlyArray<A>,
  nameOrAddress: string,
): A | undefined {
  const wanted = nameOrAddress.trim().toLowerCase();
  return (
    accounts.find((account) => account.name.toLowerCase() === wanted) ??
    accounts.find((account) => addressOf(account.from).toLowerCase() === addressOf(wanted))
  );
}
