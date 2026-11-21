# Email

Email is off until you turn it on in **Settings → Email**. Then ask an agent to email someone and it drafts the message in a card in the thread. Check the sender, recipients, subject, and message, edit anything, then press **Send** (or Ctrl/⌘+Enter). T3 Code sends it from your own mail account on the machine running the server, and the agent learns only that it was sent, plus the sender, recipients (To, Cc, and Bcc), and subject you used. **Discard** tells the agent you chose not to send it. Nothing is sent until you press Send. The card works on web, desktop, and mobile.

T3 Code does not keep mail accounts of its own. It sends with the accounts in [aerc](https://aerc-mail.org)'s `accounts.conf` on the server machine, in the same order as aerc's tabs. By default that is `~/.config/aerc/accounts.conf` (or under `$XDG_CONFIG_HOME`); to use another file, set it in **Settings → Email**, which also lists each account and whether T3 Code can send from it. With more than one account, choose the sender in the card's **From** menu. An account can send if it has `from` and `outgoing` set. `smtp://` and `smtps://` URLs with `plain`, `login`, `xoauth2`, or no authentication work, and so does a sendmail-style command such as `msmtp`. If `outgoing-cred-cmd` is set, T3 Code runs it for the password or OAuth token each time it sends, the same way aerc does. Edits to `accounts.conf` take effect on the next draft without a restart.

For a reply, the agent can select the original message through the native inbox tools. T3 derives the sender account, Reply-To recipient and threading headers before opening the same reviewable card. Nothing is sent automatically.

## Inbox reading and tagging

In **Settings → Email → Inbox** on web or desktop, separately enable inbox access and, if wanted, tagging. These are off by default; turning on drafts does not expose your inbox. Agents controlled from mobile use the same inbox tools and reviewable reply card. Inbox tools are available to agents running inside this T3 environment, not external MCP clients or linked environments. They use the server host's existing [notmuch](https://notmuchmail.org/) index; no new mailbox, account authentication or mail sync is provisioned.

Set the notmuch config path if it differs from the host's default. Configure account scopes as JSON, for example `[{"name":"work","query":"path:work/**"}]`. Account names matching the sender names make replies choose the right sender. Only configured scopes are accessible; spam, junk, trash and deleted messages are excluded. Search includes read and unread mail, and reading never marks a message read. Large text and attachments are returned in explicit chunks so an agent can continue reading without flooding its context.

Tagging targets exact message IDs and preserves unrelated tags. Marking read changes `unread`; mapped flags require notmuch's `maildir.synchronize_flags=true`. Tags belong to logical messages across indexed copies. Custom tags are local labels, not Gmail labels or Outlook categories. A successful local tag change is not proof that the mail server has acknowledged it. No archive, deletion or direct-send tool is provided.

Optionally configure refresh as a trusted executable/argument JSON array, such as `["/path/to/mail-sync.sh"]`; `[]` disables it. T3 invokes that command without a shell only when refresh is explicitly authorized. Your sync wrapper may reconcile flags, expunge mail or run routing hooks. Completion proves only that the command completed, not that every account is fresh. Reads never refresh automatically.

Agents use these native tools instead of direct aerc/notmuch commands, mailbox files or mail credentials. Retire direct-access mail skills once the connector is deployed and configured. Daily-review instructions should persist their report before calling `email_tag` to remove `unread` from actually reviewed messages; assignment-context reads must leave tags unchanged. The connector does not itself certify that a message was reviewed. Its routing policy is not an OS sandbox: a same-user full-access shell can still reach host credentials unless separately isolated.

## Sending behavior

T3 Code does not save a copy of sent mail. Gmail and Outlook keep one in your Sent folder, and your next mail sync brings it down. If a send fails, the card stays open with the mail server's error so you can fix it and try again. A draft closes if its agent stops or waits more than 10 minutes.
