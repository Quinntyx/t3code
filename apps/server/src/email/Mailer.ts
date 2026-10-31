import {
  EmailRequestError,
  type OrchestrationV2EmailAccount,
  type OrchestrationV2EmailDraft,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Nodemailer from "nodemailer";

import {
  findAercAccount,
  parseAercAccounts,
  parseAercOutgoing,
  type AercAccount,
} from "./aercAccounts.ts";

const CREDENTIAL_TIMEOUT = Duration.seconds(30);
const SMTP_TIMEOUTS = { connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000 };

/** Sends mail as the server host's aerc accounts. */
export class Mailer extends Context.Service<
  Mailer,
  {
    /** Empty when this host has no aerc account that can send. */
    readonly accounts: Effect.Effect<ReadonlyArray<OrchestrationV2EmailAccount>>;
    readonly send: (draft: OrchestrationV2EmailDraft) => Effect.Effect<void, EmailRequestError>;
  }
>()("t3/email/Mailer") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* Config.all({
    home: Config.String("HOME").pipe(Config.withDefault("")),
    configHome: Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault("")),
  }).pipe(Effect.orDie);
  const accountsFile = path.join(
    env.configHome || path.join(env.home, ".config"),
    "aerc",
    "accounts.conf",
  );

  // Read on each use so edits to the mail client's config apply without a restart.
  const loadAccounts = fileSystem.readFileString(accountsFile).pipe(
    Effect.map(parseAercAccounts),
    Effect.orElseSucceed((): ReadonlyArray<AercAccount> => []),
  );

  const credential = Effect.fn("Mailer.credential")(function* (command: string) {
    const output = yield* spawner
      .spawn(
        ChildProcess.make("sh", ["-c", command], {
          stdin: "ignore",
          stderr: "pipe",
        }),
      )
      .pipe(
        Effect.flatMap((handle) =>
          Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.scoped,
        Effect.timeoutOption(CREDENTIAL_TIMEOUT),
        Effect.mapError((cause) => new EmailRequestError({ reason: "credentials_failed", cause })),
      );
    if (Option.isNone(output)) {
      return yield* new EmailRequestError({
        reason: "credentials_failed",
        detail: "The credential command timed out.",
      });
    }
    const [stdout, stderr, exitCode] = output.value;
    const value = stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (exitCode !== 0 || value === "") {
      const said = stderr.trim().split(/\r?\n/).at(-1);
      return yield* new EmailRequestError({
        reason: "credentials_failed",
        ...(said ? { detail: said } : {}),
      });
    }
    return value;
  });

  const transportFor = Effect.fn("Mailer.transportFor")(function* (account: AercAccount) {
    const outgoing = parseAercOutgoing(account.outgoing);
    switch (outgoing.kind) {
      case "unsupported":
        return yield* new EmailRequestError({
          reason: "unsupported_account",
          ...(outgoing.scheme ? { detail: `(${outgoing.scheme})` } : {}),
        });
      case "sendmail":
        return Nodemailer.createTransport({
          sendmail: true,
          path: outgoing.command,
          ...(outgoing.args.length > 0 ? { args: [...outgoing.args] } : {}),
          newline: "unix",
        });
      case "smtp": {
        const password =
          account.outgoingCredCmd === undefined
            ? outgoing.password
            : yield* credential(account.outgoingCredCmd);
        const user = outgoing.user ?? "";
        return Nodemailer.createTransport({
          host: outgoing.host,
          port: outgoing.port,
          secure: outgoing.tls === "implicit",
          requireTLS: outgoing.tls === "starttls",
          ignoreTLS: outgoing.tls === "none",
          ...SMTP_TIMEOUTS,
          // Like aerc, an account without credentials sends unauthenticated.
          ...(outgoing.auth === "none" || (user === "" && password === undefined)
            ? {}
            : outgoing.auth === "xoauth2"
              ? {
                  auth: {
                    type: "OAuth2" as const,
                    user,
                    accessToken: password ?? "",
                  },
                }
              : {
                  authMethod: outgoing.auth === "login" ? "LOGIN" : "PLAIN",
                  auth: { user, pass: password ?? "" },
                }),
        });
      }
    }
  });

  const send: Mailer["Service"]["send"] = Effect.fn("Mailer.send")(function* (draft) {
    const account = findAercAccount(yield* loadAccounts, draft.account);
    if (account === undefined) return yield* new EmailRequestError({ reason: "unknown_account" });
    const transport = yield* transportFor(account);
    // No timeout of our own: abandoning a send that may still deliver invites a duplicate on retry.
    // The transport's own socket timeouts end a stalled send as a failure.
    yield* Effect.tryPromise({
      try: () =>
        transport.sendMail({
          from: account.from,
          to: [...draft.to],
          ...(draft.cc.length > 0 ? { cc: [...draft.cc] } : {}),
          ...(draft.bcc.length > 0 ? { bcc: [...draft.bcc] } : {}),
          subject: draft.subject,
          text: draft.body,
        }),
      catch: (cause) =>
        new EmailRequestError({
          reason: "send_failed",
          ...(cause instanceof Error && cause.message ? { detail: cause.message } : {}),
          cause,
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => transport.close())));
  });

  return Mailer.of({
    accounts: loadAccounts.pipe(
      Effect.map((accounts) => accounts.map(({ name, from }) => ({ name, from }))),
    ),
    send,
  });
});

export const layer = Layer.effect(Mailer, make);
