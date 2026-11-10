# Providers, Identity & Notifications

How DocThread resolves sources, identities, and delivers notifications. (Moved out of the README for brevity — linked from the main README.)

## Identity Picker

Type `@`, then enter a name, alias, login, or email search term. Results show a friendly name and
the provider handle that will be inserted. Choosing a result stores stable provider identity keys
beside the immutable comment body. Editing the inserted token before submission removes its
resolution.

GitHub searches collaborators in the current repository, which works for EMU accounts where
global user search does not. Entra uses Microsoft Graph advanced search. A typed email is a search
term, not a mention or notification by itself. Resolved directory contacts are transient and never
persisted in review JSON; deliverable contacts may be sent to the allowlisted notification relay.

## @mention email notifications

When a mention resolves to a real directory identity, the browser can send an email request to
the managed `/api/notify` relay independently of feedback persistence, including local-only feedback.
The relay response confirms webhook acceptance, not delivery to the recipient. The relay
forwards the request server-side to a webhook (`NOTIFY_WEBHOOK_URL` — for example an Azure Logic App
"When an HTTP request is received" trigger) that sends the Outlook mail. This is **not** an open
relay: every recipient is checked against `NOTIFY_ALLOWED_DOMAINS` (comma-separated; defaults to
`microsoft.com`) and the webhook secret is never exposed to the client.

Coverage includes directory mentions surfaced through Microsoft Graph — including on GitHub-hosted
docs — and a viewer mentioning their own alias. Native GitHub `@login` collaborator mentions rely on
GitHub's own notifications, and the email relay is skipped when a mention carries no deliverable
address. Set `NOTIFY_WEBHOOK_URL` (and optionally `NOTIFY_ALLOWED_DOMAINS`) in `.env.local` for local
development, or as Static Web App application settings in production. Native GitHub dispatch uses
`pending -> attempted -> terminal` after durable comment/attempt acceptance. Email/Teams request
outcomes and feedback-save outcomes are reported separately. Source and feedback are captured before
awaiting notification work, so a later UI source cannot become the operation's destination.

Beyond email, an in-app **notification center** (a bell/inbox in the header) surfaces @mentions,
replies, and assignments, with optional **Microsoft Teams** delivery through the same allowlisted
`/api/notify` relay ([#31](https://github.com/gim-home/DocThread/issues/31)).

## Sources

### GitHub

Paste a blob or raw URL. DocThread resolves every bounded ref/path boundary against exact branches,
tags, and commits. Branches can save reviews and source edits; tags and commits remain local-only.
Generated DocThread links encode the canonical target instead of relying on blob-URL parsing.

Hosted private reads and writes use the visitor's GitHub OAuth token directly with scopes
`repo read:org`. Resolved notification recipients are rechecked by global node ID, current login,
repository collaboration, Issues availability, and caller permission immediately before dispatch.

### Azure Repos

Paste a file URL. Missing versions resolve to the provider-returned default branch before any
storage key is created. Branch writes use the expected branch-tip commit as the CAS token.
Tag and commit URLs are read-only.

Local development can use `VITE_ADO_TRANSPORT=dev-cli`. The secure hosted build sets the transport
to `off`, so Azure Repos loading is intentionally unavailable there until direct delegated ADO
access is explicitly enabled and validated. **On the hosted site this means ADO work-item review is
unavailable — ADO users must run locally** (`dev-cli`) until enabled; tracked in
[#115](https://github.com/gim-home/DocThread/issues/115).

### ADO Work Items

Paste a work-item URL. Project-less URLs resolve `System.TeamProject` from the live item before
keying. Local development can render and edit `System.Description` with optimistic revision
checking.

Work-item review data is stored either as a JSON **attachment** on the item (the default) or as a
single human-readable managed **discussion** comment — selectable per session. The discussion mode
writes and updates one managed comment in place; the former Description store mode has been removed
so reviews never overwrite `System.Description`. There is no Git-backed snapshot fallback or shared
work-item review store.

Failed attachment/discussion responses are surfaced instead of treated as successful saves or
missing reviews. Differing local and saved feedback remains available through **Compare feedback**;
combining the copies is local-only until **Save review**. The recovery UI does not add a new ADO
concurrency protocol or make hosted work-item access available.

Hosted work-item collaboration remains disabled behind issue #15. The replacement must authorize
every operation against the caller's ADO identity and implement the same merge/CAS contract.

