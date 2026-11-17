import {
  EmailAttachmentInput,
  EmailAttachmentResult,
  EmailInboxAccountsResult,
  EmailInboxError,
  EmailMessageRef,
  EmailReadInput,
  EmailReadResult,
  EmailRefreshResult,
  EmailSearchInput,
  EmailSearchResult,
  EmailTagInput,
  EmailTagResult,
  type EmailMessageSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";

const EXCLUDED = ["spam", "deleted", "trash", "junk"];
const FLAG_TAGS = new Set(["unread", "flagged", "draft", "passed", "replied"]);
const TEXT_CHUNK = 24_000;
const ATTACHMENT_CHUNK = 48_000;
const OUTPUT_LIMIT = 32 * 1024 * 1024;

const RawMessage = Schema.Struct({
  id: Schema.String,
  match: Schema.Boolean,
  excluded: Schema.optional(Schema.Boolean),
  timestamp: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  tags: Schema.Array(Schema.String),
  body: Schema.optional(Schema.Array(Schema.Unknown)),
});
const RawPart = Schema.Struct({
  id: Schema.Number,
  "content-type": Schema.String,
  filename: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
});
const decodeMessage = Schema.decodeUnknownOption(RawMessage);
const decodePart = Schema.decodeUnknownOption(RawPart);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(EmailMessageRef.fields.messageId));
const isInboxError = Schema.is(EmailInboxError);

export class MailInbox extends Context.Service<
  MailInbox,
  {
    readonly accounts: Effect.Effect<typeof EmailInboxAccountsResult.Type, EmailInboxError>;
    readonly search: (
      input: EmailSearchInput,
    ) => Effect.Effect<typeof EmailSearchResult.Type, EmailInboxError>;
    readonly read: (input: EmailReadInput) => Effect.Effect<EmailReadResult, EmailInboxError>;
    readonly tag: (input: EmailTagInput) => Effect.Effect<EmailTagResult, EmailInboxError>;
    readonly attachment: (
      input: EmailAttachmentInput,
    ) => Effect.Effect<typeof EmailAttachmentResult.Type, EmailInboxError>;
    readonly refresh: () => Effect.Effect<typeof EmailRefreshResult.Type, EmailInboxError>;
    readonly replyContext: (
      ref: EmailMessageRef,
    ) => Effect.Effect<EmailMessageSummary, EmailInboxError>;
  }
>()("t3/email/MailInbox") {}

const exactId = (id: string) => `id:"${id.replaceAll('"', '""')}"`;

const balancedQuery = (query: string) => {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < query.length; index++) {
    const char = query[index];
    if (char === '"') {
      if (quoted && query[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && char === "(") depth++;
    else if (!quoted && char === ")" && --depth < 0) return false;
  }
  return depth === 0 && !quoted;
};

const inputDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (input: unknown) =>
    decode(input).pipe(
      Effect.mapError((cause) => new EmailInboxError({ reason: "invalid_request", cause })),
    );
};
const decodeSearch = inputDecoder(EmailSearchInput);
const decodeRead = inputDecoder(EmailReadInput);
const decodeTag = inputDecoder(EmailTagInput);
const decodeAttachment = inputDecoder(EmailAttachmentInput);
const decodeRef = inputDecoder(EmailMessageRef);

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
  const refreshLock = yield* Semaphore.make(1);
  const expandHome = (value: string) =>
    value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;

  const configuration = Effect.fn("MailInbox.configuration")(function* (account?: string) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new EmailInboxError({ reason: "backend_unavailable", cause })),
    );
    if (!settings.emailInboxEnabled) return yield* new EmailInboxError({ reason: "disabled" });
    const matches = settings.emailInboxAccounts.filter((item) => item.name === account);
    if (account !== undefined && matches.length !== 1) {
      return yield* new EmailInboxError({ reason: "unknown_account" });
    }
    return { settings, query: matches[0]?.query ?? "" };
  });

  const execute = Effect.fn("MailInbox.execute")(function* (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs = 30_000,
  ) {
    const output = yield* spawner
      .spawn(
        ChildProcess.make(command, [...args], {
          stdin: "ignore",
          stderr: "ignore",
          shell: false,
        }),
      )
      .pipe(
        Effect.mapError((cause) => new EmailInboxError({ reason: "backend_unavailable", cause })),
        Effect.flatMap((handle) =>
          Effect.all(
            [
              handle.stdout.pipe(
                Stream.mapError(
                  (cause) => new EmailInboxError({ reason: "backend_failed", cause }),
                ),
                Stream.limitBytes(OUTPUT_LIMIT, () =>
                  Stream.fail(new EmailInboxError({ reason: "output_limit" })),
                ),
                Stream.runCollect,
                Effect.map((chunks) => Buffer.concat(chunks)),
              ),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.mapError((cause) =>
          isInboxError(cause) ? cause : new EmailInboxError({ reason: "backend_failed", cause }),
        ),
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
      );
    if (Option.isNone(output)) return yield* new EmailInboxError({ reason: "timeout" });
    const [bytes, code] = output.value;
    if (code !== 0) return yield* new EmailInboxError({ reason: "backend_failed" });
    return bytes;
  });

  const notmuch = Effect.fn("MailInbox.notmuch")(function* (args: ReadonlyArray<string>) {
    const { settings } = yield* configuration();
    return yield* execute("notmuch", [
      ...(settings.emailNotmuchConfigFile
        ? [`--config=${expandHome(settings.emailNotmuchConfigFile)}`]
        : []),
      ...args,
    ]);
  });
  const json = Effect.fn("MailInbox.json")(function* (args: ReadonlyArray<string>) {
    const bytes = yield* notmuch(args);
    return yield* decodeJson(bytes.toString("utf8")).pipe(
      Effect.mapError((cause) => new EmailInboxError({ reason: "invalid_backend_data", cause })),
    );
  });
  const scopedQuery = (accountQuery: string, query: string) =>
    [
      ...[accountQuery, query]
        .filter((term) => term.trim() !== "" && term.trim() !== "*")
        .map((term) => `(${term})`),
      ...EXCLUDED.map((tag) => `NOT tag:${tag}`),
    ].join(" AND ");

  const loadMessage = Effect.fn("MailInbox.loadMessage")(function* (
    ref: EmailMessageRef,
    body: boolean,
  ) {
    const { query } = yield* configuration(ref.account);
    const tree = yield* json([
      "show",
      "--format=json",
      `--body=${body}`,
      "--entire-thread=false",
      "--decrypt=false",
      "--include-html",
      "--",
      scopedQuery(query, exactId(ref.messageId)),
    ]);
    const pending = [tree];
    const messages: Array<typeof RawMessage.Type> = [];
    let visited = 0;
    while (pending.length > 0) {
      if (++visited > 10_000) return yield* new EmailInboxError({ reason: "invalid_backend_data" });
      const node = pending.pop();
      if (Array.isArray(node)) pending.push(...node);
      else if (Predicate.isObject(node)) {
        const decoded = decodeMessage(node);
        if (Option.isNone(decoded))
          return yield* new EmailInboxError({ reason: "invalid_backend_data" });
        messages.push(decoded.value);
      }
    }
    const message = messages[0];
    if (
      messages.length !== 1 ||
      message === undefined ||
      message.id !== ref.messageId ||
      !message.match ||
      message.excluded ||
      message.tags.some((tag) => EXCLUDED.includes(tag))
    ) {
      return yield* new EmailInboxError({ reason: "not_found" });
    }
    return message;
  });
  const summary = (account: string, message: typeof RawMessage.Type): EmailMessageSummary => ({
    account,
    messageId: message.id,
    headers: Object.fromEntries(
      Object.entries(message.headers)
        .slice(0, 30)
        .map(([name, value]) => [name.slice(0, 100), value.slice(0, 2000)]),
    ),
    headersTruncated:
      Object.keys(message.headers).length > 30 ||
      Object.entries(message.headers).some(
        ([name, value]) => name.length > 100 || value.length > 2000,
      ),
    tags: message.tags,
    timestamp: message.timestamp,
  });
  const partsOf = (message: typeof RawMessage.Type) => {
    const pending: unknown[] = [...(message.body ?? [])];
    const parts: Array<typeof RawPart.Type> = [];
    while (pending.length > 0) {
      const node = pending.pop();
      const decoded = decodePart(node);
      if (Option.isNone(decoded)) {
        if (Predicate.isObject(node) && Array.isArray(node.body)) pending.push(...node.body);
        continue;
      }
      const part = decoded.value;
      if (Array.isArray(part.content)) pending.push(...part.content);
      else parts.push(part);
    }
    return parts.sort((left, right) => left.id - right.id);
  };

  const accounts = configuration().pipe(
    Effect.map(({ settings }) => ({
      accounts: settings.emailInboxAccounts.map(({ name }) => ({ name })),
      taggingEnabled: settings.emailTaggingEnabled,
      refreshAvailable: settings.emailRefreshCommand.length > 0,
    })),
  );
  const search = Effect.fn("MailInbox.search")(function* (input: EmailSearchInput) {
    const request = yield* decodeSearch(input);
    if (!balancedQuery(request.query))
      return yield* new EmailInboxError({ reason: "invalid_request" });
    const { query } = yield* configuration(request.account);
    const scope = scopedQuery(query, request.query);
    const count = (yield* notmuch(["count", "--", scope])).toString("utf8").trim();
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)))
      return yield* new EmailInboxError({ reason: "invalid_backend_data" });
    const total = Number(count);
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 50;
    const selected = yield* json([
      "search",
      "--format=json",
      "--output=messages",
      "--sort=newest-first",
      `--limit=${limit}`,
      `--offset=${offset}`,
      "--",
      scope,
    ]);
    const ids = yield* decodeIds(selected).pipe(
      Effect.mapError((cause) => new EmailInboxError({ reason: "invalid_backend_data", cause })),
    );
    if (ids.length > limit) return yield* new EmailInboxError({ reason: "invalid_backend_data" });
    const messages = yield* Effect.forEach(
      ids,
      (messageId) =>
        loadMessage({ account: request.account, messageId }, false).pipe(
          Effect.map((message) => summary(request.account, message)),
        ),
      { concurrency: 4 },
    );
    return {
      messages,
      total,
      nextOffset: ids.length > 0 && offset + ids.length < total ? offset + ids.length : null,
      freshness: "existing_index_remote_unverified" as const,
    };
  });
  const read = Effect.fn("MailInbox.read")(function* (input: EmailReadInput) {
    const request = yield* decodeRead(input);
    const message = yield* loadMessage(request, true);
    const parts = partsOf(message);
    const selected =
      request.part === undefined
        ? parts.find(
            (part) => typeof part.content === "string" && part["content-type"].startsWith("text/"),
          )
        : parts.find(
            (part) =>
              part.id === request.part &&
              typeof part.content === "string" &&
              part["content-type"].startsWith("text/"),
          );
    if (request.part !== undefined && selected === undefined)
      return yield* new EmailInboxError({ reason: "unknown_part" });
    const content = typeof selected?.content === "string" ? selected.content : "";
    const offset = request.offset ?? 0;
    if (
      offset > content.length ||
      (offset > 0 &&
        /[\uDC00-\uDFFF]/.test(content[offset] ?? "") &&
        /[\uD800-\uDBFF]/.test(content[offset - 1] ?? ""))
    )
      return yield* new EmailInboxError({ reason: "invalid_request" });
    let end = Math.min(content.length, offset + TEXT_CHUNK);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end--;
    const partsOffset = request.partsOffset ?? 0;
    if (partsOffset > parts.length)
      return yield* new EmailInboxError({ reason: "invalid_request" });
    return {
      ...summary(request.account, message),
      nextPartsOffset: partsOffset + 100 < parts.length ? partsOffset + 100 : null,
      parts: parts.slice(partsOffset, partsOffset + 100).map((part) => ({
        id: part.id,
        contentType: part["content-type"],
        ...(part.filename === undefined ? {} : { filename: part.filename }),
        text: typeof part.content === "string" && part["content-type"].startsWith("text/"),
      })),
      part: selected?.id ?? null,
      text: content.slice(offset, end),
      totalCharacters: content.length,
      ...(selected === undefined
        ? {
            contentWarning:
              "No decodable text body is available. Inspect relevant attachments; encrypted or inaccessible content is not a completed review.",
          }
        : {}),
      nextOffset: end < content.length ? end : null,
      untrusted: true as const,
    };
  });
  const tag = Effect.fn("MailInbox.tag")(function* (input: EmailTagInput) {
    const request = yield* decodeTag(input);
    const { settings, query: accountQuery } = yield* configuration(request.account);
    const configFile = settings.emailNotmuchConfigFile;
    if (!settings.emailTaggingEnabled)
      return yield* new EmailInboxError({ reason: "tagging_disabled" });
    if (
      request.add.some((item) => request.remove.includes(item)) ||
      request.remove.includes("inbox") ||
      request.add.some((item) => EXCLUDED.includes(item))
    ) {
      return yield* new EmailInboxError({ reason: "invalid_request" });
    }
    if ([...request.add, ...request.remove].some((item) => FLAG_TAGS.has(item))) {
      const flags = (yield* notmuch(["config", "get", "maildir.synchronize_flags"]))
        .toString("utf8")
        .trim();
      if (flags !== "true") return yield* new EmailInboxError({ reason: "flag_sync_disabled" });
    }
    const outcomes = yield* Effect.forEach(
      [...new Set(request.messageIds)],
      (messageId) =>
        Effect.gen(function* () {
          const ref = { account: request.account, messageId };
          const before = yield* loadMessage(ref, false);
          const matches = (tags: ReadonlyArray<string>) =>
            request.add.every((item) => tags.includes(item)) &&
            request.remove.every((item) => !tags.includes(item));
          if (matches(before.tags))
            return { messageId, status: "unchanged" as const, tags: before.tags };
          const current = yield* configuration(request.account);
          if (!current.settings.emailTaggingEnabled)
            return yield* new EmailInboxError({ reason: "tagging_disabled" });
          if (
            current.query !== accountQuery ||
            current.settings.emailNotmuchConfigFile !== configFile
          ) {
            return yield* new EmailInboxError({ reason: "invalid_request" });
          }
          const error = yield* execute("notmuch", [
            ...(configFile ? [`--config=${expandHome(configFile)}`] : []),
            "tag",
            ...request.add.map((item) => `+${item}`),
            ...request.remove.map((item) => `-${item}`),
            "--",
            exactId(messageId),
          ]).pipe(
            Effect.match({ onSuccess: () => undefined, onFailure: (failure) => failure.reason }),
          );
          const after = yield* loadMessage(ref, false);
          return matches(after.tags)
            ? { messageId, status: "updated" as const, tags: after.tags }
            : {
                messageId,
                status: "failed" as const,
                tags: after.tags,
                error: error ?? "change_not_observed",
              };
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              messageId,
              status: "failed" as const,
              tags: [] as string[],
              error: error.reason,
            }),
          ),
        ),
      { concurrency: 1 },
    );
    return { outcomes, remoteAcknowledged: false as const };
  });
  const attachment = Effect.fn("MailInbox.attachment")(function* (input: EmailAttachmentInput) {
    const request = yield* decodeAttachment(input);
    const message = yield* loadMessage(request, true);
    const part = partsOf(message).find((item) => item.id === request.part);
    if (part === undefined) return yield* new EmailInboxError({ reason: "unknown_part" });
    const { settings, query } = yield* configuration(request.account);
    const offset = request.offset ?? 0;
    const extracted = yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "notmuch",
          [
            ...(settings.emailNotmuchConfigFile
              ? [`--config=${expandHome(settings.emailNotmuchConfigFile)}`]
              : []),
            "show",
            "--format=raw",
            `--part=${request.part}`,
            "--entire-thread=false",
            "--decrypt=false",
            "--",
            scopedQuery(query, exactId(request.messageId)),
          ],
          { stdin: "ignore", stderr: "ignore", shell: false },
        ),
      );
      return yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.runFold(
              () => ({ total: 0, chunks: [] as Buffer[] }),
              (state, chunk) => {
                const start = Math.max(0, offset - state.total);
                const end = Math.min(chunk.length, offset + ATTACHMENT_CHUNK - state.total);
                if (end > start) state.chunks.push(Buffer.from(chunk.subarray(start, end)));
                state.total += chunk.length;
                return state;
              },
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(30_000),
      Effect.mapError((cause) => new EmailInboxError({ reason: "backend_failed", cause })),
    );
    if (Option.isNone(extracted)) return yield* new EmailInboxError({ reason: "timeout" });
    const [data, code] = extracted.value;
    if (code !== 0) return yield* new EmailInboxError({ reason: "backend_failed" });
    if (offset > data.total) return yield* new EmailInboxError({ reason: "invalid_request" });
    const end = Math.min(data.total, offset + ATTACHMENT_CHUNK);
    return {
      contentType: part["content-type"],
      ...(part.filename === undefined ? {} : { filename: part.filename }),
      base64: Buffer.concat(data.chunks).toString("base64"),
      totalBytes: data.total,
      nextOffset: end < data.total ? end : null,
      untrusted: true as const,
    };
  });
  const refresh = Effect.fn("MailInbox.refresh")(function* () {
    return yield* refreshLock.withPermit(
      Effect.gen(function* () {
        const { settings } = yield* configuration();
        const [command, ...args] = settings.emailRefreshCommand;
        if (command === undefined)
          return { status: "unavailable" as const, remoteAcknowledged: false as const };
        return yield* execute(expandHome(command), args, 15 * 60_000).pipe(
          Effect.match({
            onSuccess: () => ({ status: "completed" as const, remoteAcknowledged: false as const }),
            onFailure: () => ({ status: "failed" as const, remoteAcknowledged: false as const }),
          }),
        );
      }),
    );
  });
  const replyContext = Effect.fn("MailInbox.replyContext")(function* (input: EmailMessageRef) {
    const ref = yield* decodeRef(input);
    const message = yield* loadMessage(ref, false);
    const { settings, query } = yield* configuration(ref.account);
    const raw = yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "notmuch",
          [
            ...(settings.emailNotmuchConfigFile
              ? [`--config=${expandHome(settings.emailNotmuchConfigFile)}`]
              : []),
            "show",
            "--format=raw",
            "--part=0",
            "--entire-thread=false",
            "--decrypt=false",
            "--",
            scopedQuery(query, exactId(ref.messageId)),
          ],
          { stdin: "ignore", stderr: "ignore", shell: false },
        ),
      );
      let prefix = "";
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.takeUntil((chunk) => {
          prefix += chunk;
          return /\r?\n\r?\n/.test(prefix) || prefix.length > 128_000;
        }),
        Stream.runDrain,
      );
      if (!/\r?\n\r?\n/.test(prefix)) {
        const code = yield* handle.exitCode;
        return yield* new EmailInboxError({
          reason: code === 0 ? "invalid_backend_data" : "backend_failed",
        });
      }
      return prefix.split(/\r?\n\r?\n/, 1)[0] ?? "";
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(30_000),
      Effect.mapError((cause) => new EmailInboxError({ reason: "backend_failed", cause })),
    );
    if (Option.isNone(raw)) return yield* new EmailInboxError({ reason: "timeout" });
    if (raw.value.length > 128_000) return yield* new EmailInboxError({ reason: "output_limit" });
    const headers = { ...message.headers };
    for (const line of raw.value.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
      const match = /^(Reply-To|References|Message-ID):\s*(.*)$/i.exec(line);
      if (match?.[1] && match[2]) headers[match[1].toLowerCase()] = match[2];
    }
    return { ...summary(ref.account, message), headers };
  });
  return MailInbox.of({ accounts, search, read, tag, attachment, refresh, replyContext });
});

export const layer = Layer.effect(MailInbox, make);
