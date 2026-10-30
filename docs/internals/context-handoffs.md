# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

## Machine handoff safety boundary

Machine handoffs relay a server-owned snapshot through the authenticated client, not a peer connection.
Import always creates a detached managed worktree, even for an ordinary source checkout; an existing
target is never overwritten. Hidden checkpoint commits capture the index and raw working files without
moving the source branch, refreshing its index, or using its stash. Bundle prerequisites must already
exist in the cloned destination, so mismatched or shallow clones can refuse import safely.

The snapshot carries provider-handoff-eligible text, not native sessions, approval ownership, attachments,
or same-environment lineage. Import commits one idle-thread command; the next user turn goes through
`ContextHandoffServiceV2`. Retry ids reserve one destination thread and workspace. A failed database
commit leaves the isolated workspace available for that same retry rather than risking deletion after
an ambiguous commit outcome.

Windows hosts cannot preserve POSIX executable modes and do not advertise this capability.
Repository-subdirectory projects, unborn or SHA-256 repositories, symlinks, submodules, conflicted or
special indexes (sparse, assume-unchanged, intent-to-add), Git content filters or working-tree encoding/newline
conversions, and in-progress Git operations are explicitly
refused. Ignored files are not included: clone/file-copy writes to the destination project root, not
the new isolated worktree. Import returns a warning that destination-trusted setup must run before
continuing. It deliberately does not execute source-transferred setup scripts or link ignored data. The
wire snapshot is capped at 8 MiB, its bundle at 5 MiB, and changed/untracked bytes at 64 MiB. Trees are
limited to 100,000 files. Unchanged tracked blobs reuse Git objects and are streamed into the isolated
worktree; a large existing asset does not consume the dirty-file budget.
Live, queued, approval, and background work must stop before export. Only snapshot creation and isolated
import write Git objects; neither operation adds commits to the user's branch.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
