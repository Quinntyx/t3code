# Context in portable handoffs

T3 Code transfers conversation context when you switch providers, hand a thread off to another
machine, continue through a portable restart, or use a fork that the provider cannot resume itself.

Short conversations transfer intact. For longer conversations, T3 Code favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use T3 Code's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. A handoff is a budgeted selection, not an
agent-written summary.

## Continuing on another machine

Stop active turns, queued work, approvals, and background tasks first, and connect both machines.

On web and desktop, select another machine from **Run on** in the thread's composer. The transfer
starts immediately. It keeps the current provider and model when available there, otherwise uses
an available destination default. You can change that selection in the destination composer before
sending your next message. Context handoff appears inline in the conversation.

If the project is missing, use **Add to another machine** in the same menu. The existing clone dialog
handles the destination folder, checkout layout, and optional ignored-file copies. The thread
transfer continues automatically when cloning and file copies finish.

On mobile, open the thread's settings and choose **Machine handoff**, then choose its destination
project, provider, and model. A different repository is not a substitute.

The destination receives a new thread and isolated worktree at the source revision, including
unpushed history, staged and unstaged changes, and non-ignored untracked files. The source can be a
T3-managed worktree or an ordinary Git checkout. Neither checkout is overwritten, and no commits are
added to your branch. Your original thread stays available; to return, open it or hand the destination
thread back after stopping its work. No agent starts until you send a message.

Ignored files, attachments, provider sessions, approvals, and authentication do not travel with the
working-state snapshot. Prepare dependencies and ignored configuration in the destination worktree
before continuing. The normal clone flow's optional file copies populate the destination project,
not the newly isolated worktree. Transfers that exceed the size limit or use unsupported Git states
are rejected without changing your source. Both servers need machine-handoff support.

This currently supports repository-root projects on Linux and macOS with SHA-1 Git repositories.
Safe relative symlinks stay symlinks; links outside the repository are rejected. Clean submodules
keep their recorded revisions but need initialization on the destination. Commit or otherwise
resolve changes inside submodules first. Repositories with in-progress merges or rebases, special
index flags, or content filters need those states resolved before transfer. The transfer is limited
to an 8 MiB snapshot, including a 5 MiB compressed Git bundle, and 64 MiB of changed file content.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If the target conversation has no room for the handoff, T3 Code starts
a fresh provider conversation with a bounded selection of saved history and sends your request
automatically. You do not need to compact manually. If the request and attachments leave too little
room even in a fresh conversation, shorten the request or select a larger-context model. T3 Code
never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). This is an upper bound, not a provider context-window
guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
