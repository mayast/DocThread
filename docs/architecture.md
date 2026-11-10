# Architecture & Persistence

The module map and how review state is persisted. (Moved out of the README for brevity.)

## Architecture

```text
src/identity.ts            provider identity resolution and ranking
src/components/MentionEditor.tsx
                           shared stateful people picker
src/anchor.ts              text anchoring and re-anchor confidence
src/review.ts              review-status filters and counts
src/reviewUi.ts            source-bound operation snapshots and transient UI outcomes
src/reviewRecovery.ts      browser Markdown drafts and explicit local review recovery
src/reviewSummary.ts       review digest + optional AI summary (#30)
src/readiness.ts           AI-readiness rubric, score, and gaps (#44)
src/reviewPolicy.ts        REVIEW.md policy parse + severity/nit-cap rules (#89)
src/aiSkill.ts             filename-agnostic skill parsing + request payload shape (#92)
src/aiReview.ts            AI reviewer pass — local + AI findings (#43)
src/suggestion.ts          suggested-edit locate/diff/apply (#35)
src/aiSuggest.ts           AI-drafted suggested edits (#63)
src/reactions.ts           comment emoji reactions (#37)
src/inbox.ts               in-app notification center inbox (#31)
src/notifyTeams.ts         optional Teams notification card (#31)
src/threadLink.ts          thread deep-link build/parse (#32)
src/markdownToolbar.ts     Edit Doc formatting toolbar (#78)
src/components/CommentGutter.tsx
                           review panel: threads, filters, AI actions, findings
src/reviewSchema.ts        central untrusted sidecar decoder
src/reviewPersistence.ts   deterministic v2 merge rules
src/notification.ts        dispatch state transitions
src/notifyEmail.ts         mention email payload construction
src/notifyAllowlist.ts     recipient domain allowlist
src/mentionContacts.ts     resolved-contact cache for notifications
src/githubSource.ts        exact GitHub ref/path resolution and deep links
src/providers.ts           provider capability, persistence, and save coordinator
src/github.ts              direct visitor GitHub adapter
src/azureRepos.ts          Azure Repos branch-tip CAS adapter
src/azureAuth.ts           Azure / Microsoft Graph auth status
src/ado.ts                 work-item HTML/Markdown, revision, and review-store adapter
src/sample.ts              built-in sample document and in-app user manual
api/                       GitHub device-code, token, and allowlisted notify relays
```


## Persistence

Repository review state uses collision-safe paths such as:

```text
.docthread/v2/docs/review%20notes.md.json
```

Path segments are encoded independently without Unicode normalization. Existing v1 sidecars are
read only and accepted only when their decoded `docPath` exactly matches the requested document.
The installed PR analyzer understands v2 first and exact v1 fallback.

Signed-out or unsupported-source comments remain local-only. Anonymous users cannot mutate shared
resolve/delete/edit state. Local storage uses a canonical identity containing provider,
repository/work item, version type, ref, and raw path.

Browser-only Markdown recovery uses `docthread:document-draft:<canonical source key>` with the
existing schema-v1 envelope (`docPath`, empty `threads`, `markdown`, `updatedAt`). It never enters
a remote review sidecar. A source must load successfully before its draft is offered for explicit
comparison/restore. Matching source-save receipts clear only the draft they saved; a newer draft
is retained. Storage failure remains visible with an in-tab/export fallback.

Unposted composer/reply input stays keyed by source within the tab, without becoming a comment or
dispatching a notification. It is not persisted across page reloads. Work-item local snapshots use
the existing ADO codec; differing local/shared feedback is kept for explicit comparison and local
combination using the same immutable-core, clock and tombstone rules. Publication remains a
separate source save, and the existing provider snapshot/CAS contracts are unchanged.

