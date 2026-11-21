import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import * as MailInbox from "./MailInbox.ts";

const identity = 'id:literal" OR *@example.invalid';
const attachmentContents = "%PDF-" + "synthetic".repeat(8_000);
const message = (tags: string[], match = true) => ({
  id: identity,
  match,
  excluded: false,
  timestamp: 1,
  headers: {
    From: "Staff <staff@example.invalid>",
    Subject: "Meeting",
    "Reply-To": "reply@example.invalid",
  },
  tags,
  body: [
    {
      id: 1,
      "content-type": "multipart/mixed",
      content: [
        { id: 2, "content-type": "text/plain", content: "a".repeat(40_000) },
        { id: 3, "content-type": "text/html", content: "<p>Meeting</p>" },
        { id: 4, "content-type": "application/pdf", filename: "notice.pdf" },
      ],
    },
  ],
});

const withInbox = <A, E>(
  test: (input: {
    inbox: MailInbox.MailInbox["Service"];
    calls: string[][];
    setSettings: (patch: Partial<typeof DEFAULT_SERVER_SETTINGS>) => void;
  }) => Effect.Effect<A, E>,
  options: {
    missing?: boolean;
    tagFailsAfterWrite?: boolean;
    flags?: boolean;
    malformed?: boolean;
    changeScopeAfterRead?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      emailInboxEnabled: true,
      emailTaggingEnabled: true,
      emailNotmuchConfigFile: "/fixture/notmuch.conf",
      emailInboxAccounts: [{ name: "school", query: "path:school/**" }],
      emailRefreshCommand: ["/fixture/refresh", "--normal"],
    };
    const calls: string[][] = [];
    let tags = ["unread", "flagged", "custom"];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
        const args = command.args.map(String);
        calls.push([command.command, ...args]);
        const operation = args.find((arg) => !arg.startsWith("--"));
        let text = "";
        let code = 0;
        if (command.command === "/fixture/refresh") text = "done";
        else if (operation === "count") text = "1";
        else if (operation === "search") text = JSON.stringify([identity]);
        else if (operation === "config") text = options.flags === false ? "false" : "true";
        else if (operation === "show") {
          text = options.malformed
            ? "not json"
            : JSON.stringify([[[message(tags, !options.missing), []]]]);
          if (args.includes("--format=raw"))
            text = args.includes("--part=0")
              ? "Reply-To: reply@example.invalid\r\nReferences: <earlier@example.invalid>\r\n\t<parent@example.invalid>\r\n\r\nbody"
              : attachmentContents;
          if (options.changeScopeAfterRead)
            settings.emailInboxAccounts = [{ name: "school", query: "path:other/**" }];
        } else if (operation === "tag") {
          tags = tags.filter((tag) => !args.includes(`-${tag}`));
          for (const tag of args.filter((arg) => arg.startsWith("+"))) tags.push(tag.slice(1));
          if (options.tagFailsAfterWrite) code = 1;
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(text)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return yield* Effect.gen(function* () {
      const inbox = yield* MailInbox.MailInbox;
      return yield* test({
        inbox,
        calls,
        setSettings: (patch) => {
          Object.assign(settings, patch);
        },
      });
    }).pipe(
      Effect.provide(
        MailInbox.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed(settings),
              }),
            ),
          ),
        ),
      ),
    );
  });

it.effect("searches within an account and reads exact literal IDs without changing flags", () =>
  withInbox(({ inbox, calls }) =>
    Effect.gen(function* () {
      const found = yield* inbox.search({ account: "school", query: "*", limit: 1 });
      expect(found.total).toBe(1);
      expect(found.messages[0]?.messageId).toBe(identity);
      const first = yield* inbox.read({ account: "school", messageId: identity });
      expect(first.nextOffset).not.toBeNull();
      expect(first.tags).toEqual(["unread", "flagged", "custom"]);
      expect(first.parts).toContainEqual({
        id: 4,
        contentType: "application/pdf",
        filename: "notice.pdf",
        text: false,
      });
      const rest = yield* inbox.read({
        account: "school",
        messageId: identity,
        offset: first.nextOffset!,
      });
      expect(first.text + rest.text).toBe("a".repeat(40_000));
      expect(rest.nextOffset).toBeNull();
      const query = calls.find((call) => call.includes("count"))!.at(-1)!;
      expect(query).toContain("(path:school/**)");
      expect(query).toContain("NOT tag:spam");
      expect(query).not.toContain("(*)");
      expect(
        calls
          .filter((call) => call.includes("show"))
          .every((call) => call.at(-1)!.includes('id:"id:literal"" OR *@example.invalid"')),
      ).toBe(true);
      expect(calls.some((call) => call.includes("tag") || call[0] === "/fixture/refresh")).toBe(
        false,
      );
    }),
  ),
);

it.effect(
  "denies disabled access, unconfigured accounts and query scope escapes before execution",
  () =>
    withInbox(({ inbox, calls, setSettings }) =>
      Effect.gen(function* () {
        for (const query of ["*) OR (*) OR (*", 'subject:"unfinished']) {
          expect((yield* inbox.search({ account: "school", query }).pipe(Effect.flip)).reason).toBe(
            "invalid_request",
          );
        }
        expect(
          (yield* inbox.read({ account: "other", messageId: identity }).pipe(Effect.flip)).reason,
        ).toBe("unknown_account");
        setSettings({ emailInboxEnabled: false });
        expect((yield* inbox.accounts.pipe(Effect.flip)).reason).toBe("disabled");
        for (const changes of [
          { add: ["trash"], remove: [] },
          { add: [], remove: ["inbox"] },
        ]) {
          setSettings({ emailInboxEnabled: true });
          expect(
            (yield* inbox
              .tag({ account: "school", messageIds: [identity], ...changes })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid_request");
        }
        expect(calls).toEqual([]);
      }),
    ),
);

it.effect("rejects out-of-scope and malformed message results without tagging", () =>
  Effect.gen(function* () {
    for (const options of [{ missing: true }, { malformed: true }]) {
      yield* withInbox(
        ({ inbox, calls }) =>
          Effect.gen(function* () {
            const result = yield* inbox.tag({
              account: "school",
              messageIds: [identity],
              add: [],
              remove: ["unread"],
            });
            expect(result.outcomes[0]?.status).toBe("failed");
            expect(calls.some((call) => call.includes("tag"))).toBe(false);
          }),
        options,
      );
    }
  }),
);

it.effect(
  "tags only exact IDs, preserves unrelated tags and verifies a write despite backend failure",
  () =>
    withInbox(
      ({ inbox, calls, setSettings }) =>
        Effect.gen(function* () {
          const result = yield* inbox.tag({
            account: "school",
            messageIds: ["outside@example.invalid", identity],
            add: ["reviewed"],
            remove: ["unread"],
          });
          expect(result.outcomes[0]?.status).toBe("failed");
          expect(result.outcomes[1]).toMatchObject({
            status: "updated",
            tags: ["flagged", "custom", "reviewed"],
          });
          expect(result.remoteAcknowledged).toBe(false);
          expect(calls.filter((call) => call.includes("tag"))).toHaveLength(1);
          setSettings({ emailTaggingEnabled: false });
          expect(
            (yield* inbox
              .tag({ account: "school", messageIds: [identity], add: [], remove: ["flagged"] })
              .pipe(Effect.flip)).reason,
          ).toBe("tagging_disabled");
        }),
      { tagFailsAfterWrite: true },
    ),
);

it.effect("does not tag a message after its operator account scope changes", () =>
  withInbox(
    ({ inbox, calls }) =>
      Effect.gen(function* () {
        const result = yield* inbox.tag({
          account: "school",
          messageIds: [identity],
          add: ["reviewed"],
          remove: [],
        });
        expect(result.outcomes[0]?.status).toBe("failed");
        expect(calls.some((call) => call.includes("tag"))).toBe(false);
      }),
    { changeScopeAfterRead: true },
  ),
);

it.effect("refuses mapped flag changes when native synchronization is off", () =>
  withInbox(
    ({ inbox, calls }) =>
      Effect.gen(function* () {
        expect(
          (yield* inbox
            .tag({ account: "school", messageIds: [identity], add: [], remove: ["unread"] })
            .pipe(Effect.flip)).reason,
        ).toBe("flag_sync_disabled");
        expect(calls.some((call) => call.includes("tag"))).toBe(false);
      }),
    { flags: false },
  ),
);

it.effect("extracts only a selected attachment and refreshes only when explicitly requested", () =>
  withInbox(({ inbox, calls }) =>
    Effect.gen(function* () {
      const attachment = yield* inbox.attachment({
        account: "school",
        messageId: identity,
        part: 4,
      });
      expect(attachment.nextOffset).not.toBeNull();
      const rest = yield* inbox.attachment({
        account: "school",
        messageId: identity,
        part: 4,
        offset: attachment.nextOffset!,
      });
      expect(
        Buffer.concat([
          Buffer.from(attachment.base64, "base64"),
          Buffer.from(rest.base64, "base64"),
        ]).toString(),
      ).toBe(attachmentContents);
      expect(rest.nextOffset).toBeNull();
      const reply = yield* inbox.replyContext({ account: "school", messageId: identity });
      expect(reply.headers.references).toBe("<earlier@example.invalid> <parent@example.invalid>");
      expect(reply.headers["reply-to"]).toBe("reply@example.invalid");
      expect(attachment.filename).toBe("notice.pdf");
      expect(calls.some((call) => call[0] === "/fixture/refresh")).toBe(false);
      expect(yield* inbox.refresh()).toEqual({ status: "completed", remoteAcknowledged: false });
      expect(calls.at(-1)).toEqual(["/fixture/refresh", "--normal"]);
    }),
  ),
);
