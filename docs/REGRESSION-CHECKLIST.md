# DocThread Regression Checklist

Use this before merging or releasing. Automated checks are mandatory; manual provider checks are
required when their capability is configured.

## Review-First UX (#128)

The current control locations and action labels below supersede the historical UI names in
older feature sections. Preserve the existing Primer styling except for the approved unboxed
comment labels, primary/overflow action layout and passage navigation; do not introduce unrelated
workflow states.
See [implementation evidence and open gates](128-implementation.md).

- [ ] **Tools** contains Edit document, Open document, AI Review, and Summarize review in one flat
      menu. Source loading, recents and Sample remain available through Open document.
- [ ] Selecting rendered text opens the rail composer. Question / Suggestion / Blocking are
      immediately available, unchanged data values, with no required choice or interpretation text.
- [ ] Search, Show and Sort are directly available in Comments. Reply/Resolve remain contextual;
      Reply, Resolve/Reopen and Show passage are visible primary actions. Copy link, Delete and
      eligible configured AI drafting are in the comment's kebab menu.
- [ ] Whole comment text and thread actions render without truncation or a fixed nested scroller.
      Long discussions use page scrolling; narrow layouts retain source identity and passage links.
- [ ] The single dismissible selection hint disappears after a posted comment for that app session.
- [ ] Local-only feedback is labelled. Pending/saving/saved/failed feedback messages reflect actual
      save results for the same source/version; a stale result cannot mark newer feedback saved.
- [ ] Apply draft and Apply to draft do not write the source before the existing confirmation.
      Keep in this tab retains the draft and reports whether browser recovery storage succeeded. Commit/PR outcomes
      remain distinct from feedback saves and notification outcomes.
- [ ] A failed local write retains composer/reply/finding input, reports failure, and starts no
      provider write from that failed action. A failed source save retains input for explicit retry.
- [ ] Filtering does not discard reply drafts. Source changes/reload warn for unsent input and
      pending/failed feedback; an active operation prevents leaving even if it starts after the
      leave dialog opens. Recovery exports identify the original source.
- [ ] Exit editor retains an unapplied draft. Browser-stored Markdown survives reload and is offered
      for comparison only after successful source loading; restoring never writes the source.
      A confirmed source save removes only its matching draft, not a newer copy.
- [ ] Switching sources keeps unposted comments/replies with the original source within the tab.
      Storage failure retains the in-memory document draft across editor exit and source switching.
- [ ] ADO attachment and discussion read/write failures are reported. Failed-save local feedback
      and concurrent saved additions both survive reload. Compare feedback uses the existing
      conflict/tombstone rules; combining is local-only and a separate Save review publishes it.
- [ ] Delayed notification operations keep their original source/payload/revision and cannot cancel
      a newer comment's autosave. Notification dispatch order and retry/allowlist rules are unchanged.
- [ ] Copy failure reveals a selectable link. Source/share/save/recovery dialogs handle focus,
      Escape, return focus and unsent input. Test actual foreground keyboard use, not only events.
- [ ] Canonical and ordinary shared links load the correct source before activating a thread.
      Denied links retain the requested URL and do not activate a previous/sample thread.
- [ ] Preserve existing uncertain/orphaned anchor warnings and local/AI provenance. Do not infer
      approval, source persistence or recipient delivery from a label or a relay acceptance.
- [ ] Invitations do not grant source access. Failed invites retain input; accepted email requests
      do not claim recipient delivery. Existing invitation participation remains in Share.
- [ ] Run the uncoached reviewer trial and authorized live-provider checks before closing #128.
      Local fixture recovery evidence is not live-provider or user-validation evidence.

## Session Review Insights (#114 / #120 First Increment)

The authoritative session-only contract governs; the archived durable/executive roadmap is deferred.
See [implementation and AC evidence](114-120-session-insights.md).

- [ ] One optional Tools entry; capture off by default, no extra review steps, no retroactive capture.
- [ ] Only the existing authenticated shared-review-writable capability can capture; sample, signed-out,
      read-only and unavailable transports keep their existing behavior.
- [ ] Freeze the final displayed cohort only, with fresh run/observation IDs. Exclude policy-hidden,
      capped, unanchorable and stale results; old source/account/draft completions cannot contaminate it.
- [ ] A failed local action remains pending. Actual posted/applied outcomes and dismissal count once;
      combined post/apply is applied only. Do not confuse these with source-save or notification success.
- [ ] Off, clear, source/account changes, sign-out, teardown and reload remove capture. Clearing does not
      alter document/thread drafts. Refuse an overflowing run in full; retain earlier observations and
      show a paused notice at the 1,000-observation bound, with export/reset still available.
- [ ] Uptake for 2 posted, 1 applied, 1 dismissed and 6 pending is 3/4 = 0.75. Empty denominators are null.
      Keep local/AI/unknown and pass breakdowns separate; repeated runs are observations, not people.
- [ ] Capture/inspect/export adds no storage, sidecar, provider or log writes. Export allowed aggregate
      fields only, with selection/coverage notes and unsupported measures explicitly `not_collected`.
- [ ] Download failure retains memory with retry guidance. Verify focus return, Tab wrapping, keyboard
      Accept/Dismiss, narrow layouts and WCAG A/AA scans in Chromium, Firefox and WebKit.
- [ ] Distinguish synthetic provider fixtures from approved credentialed/live and human verification.
      Completion of this increment does not close either parent issue or waive #128's release gates.

## Automated Gates

### Comment Labels And Actions

- [ ] Question / Suggestion / Blocking use icon/text labels without backgrounds or borders.
      Unverified aliases use amber text and a dotted inline underline with an explicit status;
      resolved identities never acquire unverified styling or lose their stable keys.
- [ ] Reply, Resolve/Reopen and Show passage stay visible, readable and inside their buttons at
      desktop, 320/390px and 200% CSS zoom in light/dark themes. Long aliases wrap without overflow.
- [ ] Copy link, Delete and eligible AI drafting appear only in the kebab menu. Opening it does
      not change card height, passage alignment or scroll position; it stays within the viewport.
- [ ] Arrow keys, Home/End, Escape, Tab and outside dismissal work. Keyboard navigation skips
      disabled items; closing with Escape or an action restores focus to the kebab trigger.
- [ ] Copy success announces completion without a provider write. Clipboard denial opens a
      selectable-link dialog; closing it restores trigger focus. Canceling Delete keeps the thread;
      confirming Delete uses the existing deletion path, including its permission checks.
- [ ] Read-only shared threads cannot Resolve or Delete. Local Reply and linked Show passage
      remain available; orphaned anchors keep Show passage disabled. Local-only deletion retains
      its existing permission exception.

### Passage And Comment Pairing (#149 / #150)

- [ ] Long quotes clamp inside their own unpadded text element. No partial third line,
      label/author overlap, clipped actions or horizontal overflow at desktop, 320/390px,
      the 900px layout boundary, or 200% CSS zoom.
- [ ] Passage order is the default. Actual relocated passages, not stale stored offsets,
      determine order. All interleaves open/resolved cards in numerical and DOM order; selecting
      a card never overrides an explicit Newest, Oldest or Blocking first sort.
- [ ] In side-by-side Passage order, prioritize stable order, no overlap, then closest passage
      alignment. The selected card/draft uses its passage row when preceding cards fit above;
      otherwise it uses the closest available row below. Predecessors never move after it.
      Preserve 12px gaps, numerical/DOM order and reply/draft text through selection, growth and
      resizing. Test shared passages, page-top and deeply scrolled selections.
- [ ] Hover/focus pairs the passage, marker and card without activating, scrolling or repacking.
      Previous/Next uses the current filtered/sorted sequence, keeps the search, and disables
      at its boundaries. Marker positions do not shuffle when selection changes.
- [ ] Explicit links scroll only as much as needed. An already-visible pair stays stationary;
      reveal both ends when they fit, otherwise prioritize the requested card/header or passage.
      Show passage offers Back to comment only while its originating header is off-screen;
      keyboard return reveals and focuses that card, including at 320/390px and 200% CSS zoom.
- [ ] HTML sources preserve review parity: selected text keeps a visible draft highlight inside
      the iframe, posted passages show visible highlights, Show passage scrolls the outer page to
      the iframe passage, and Apply to draft updates the intended HTML text before source save.
- [ ] Loaded-source commenting stays enabled for supported GitHub/Azure Repos `.md` files and
      ADO work-item descriptions; blocked shared-save/recovery states may keep feedback local but
      must not disable creating a comment.
- [ ] At most one subtle connector marks a displaced active pair in desktop Passage order.
      It cannot affect layout, page width or input, and disappears immediately on narrow layouts.
- [ ] Matching passage/card numbers remain stable through search and alternate sorting.
      Mouse and keyboard passage links reveal the correct card, including filtered/resolved
      threads; quote controls reveal the corresponding passage. Orphans never link to unrelated text.
- [ ] Shared-passage markers remain distinct and do not cover document text. Narrow layouts
      remove desktop alignment gaps. Resolved cards retain readable contrast in both themes.
- [ ] Draft text stays highlighted after focus enters the composer, including formatted and
      multi-block selections. An old active thread does not compete with the draft selection.
      Cancel/post clear the draft highlight; switching sources clears/restores only its own draft.
- [ ] Blank input/caret zero never opens a mention picker. Mouse Cancel succeeds on the first
      click after clearing a draft; changing layout or sort preserves unposted comments/replies.

### Required Commands

- [ ] `npm ci` succeeds through the configured package proxy.
- [ ] `npm test` passes, including identity, mention, schema, merge, notification, source,
      provider, ADO snapshot, notify-email, notify-allowlist, OAuth route, analyzer, and
      installer suites.
- [ ] `npm run build` succeeds and prints the expected capability matrix.
- [ ] Install the pinned Playwright browser builds and run `npm run test:browser`: all Chromium,
      Firefox and WebKit scenario groups and WCAG A/AA axe scans pass, with no provider requests
      escaping the fixture. Review the per-engine report and screenshots retained by CI.
- [ ] Suggestion application cannot replace an unapplied editor/recovery draft; applying preserves
      origin/skill provenance. Undoing a draft back to the source text removes its matching recovery copy.
- [ ] Production build rejects Graph MSAL without client/tenant GUID.
- [ ] Production build rejects hosted `VITE_ADO_TRANSPORT` values other than `off`.
- [ ] No deployable `api/gh-api` or `api/ado-api` relay exists, and the Worker has no `/notify`.
- [ ] The `api/notify` relay, if present, filters recipients through `NOTIFY_ALLOWED_DOMAINS`
      before forwarding — external/disallowed addresses never reach the webhook.
- [ ] No active GitHub Pages deployment workflow exists.

### Editor spell-check (added 2026-08-28, PR #62)

- [ ] The in-place document editor has native spell-checking **on by default** (`spellcheck="true"`
      on the editor textarea): misspellings get squiggles and native right-click corrections.
- [ ] The **Spell check** toolbar toggle (shown only while editing) turns it off/on and the choice
      **persists** across reloads (localStorage `docthread:spellcheck`); a correction edits the
      draft like normal typing and never triggers a repo write on its own.
- [ ] Read-only/signed-out editing is unchanged — the editing gate and the save path behave exactly
      as before; spell-check is a client-only editor affordance.

### Edit-mode live preview (added 2026-08-28, PR #38)

- [ ] The edit toolbar exposes an **Editor / Split / Preview** toggle; the choice **persists** across
      reloads (localStorage `docthread:editor-view`). Default is **Editor** (unchanged behavior).
- [ ] The preview renders the **draft** (`draftMd`) with the same `ReactMarkdown` + `remarkGfm`
      component (`MarkdownDoc`) as the read-mode document, so output matches; it updates **live** as
      you type, and in **Split** the panes stay roughly scroll-synced.
- [ ] The preview pane is read-only (no selection/compose). The editor pane keeps its highlight
      backdrop (anchors still paint), and **Save doc** (branch commit / PR / ADO update / local)
      behaves exactly as before — the source of truth stays raw Markdown, so anchoring is unaffected.
- [ ] On narrow viewports, **Split** collapses to a single pane (editor); **Preview** stays full-width.

### Comment search & sort (added 2026-08-28, PR #34)

- [ ] The Review Status panel has a search box that narrows threads by comment body, author display
      name, author login, @mention handle, or the anchored quote (case-insensitive); the filter-tab
      counts update to reflect the active search.
- [ ] Search composes with the existing intent / Mine / Needs-re-anchor / All filters (filter →
      search → sort); clearing the search restores the prior filtered view.
- [ ] The sort control reorders threads (Newest / Oldest / Blocking first) without losing the active
      filter or search; sorting never mutates the underlying thread list.
- [ ] Client-side only — no data/schema change, no repo write; anchoring and persistence unaffected.

### Suggested edits (added 2026-08-28, PR #35)

- [ ] In the compose popup, **Suggest an edit** captures a proposed replacement for the selected text
      (pre-filled with the selection); submitting creates a thread whose `suggestion.replacement` is
      set. A suggestion may be submitted with no comment body (defaults to "Suggested change").
- [ ] The thread card renders a before/after **diff** of the anchored quote vs the replacement, with
      **Apply** and **Dismiss** actions (hidden once applied).
- [ ] **Apply** re-locates the anchor in the current document, replaces exactly that span, marks the
      suggestion `appliedAt`, resolves the thread, and runs the normal document-save path (commit /
      PR / ADO update / local). A stale anchor (surrounding text changed too much) is reported and
      **not** applied — the document is never corrupted.
- [ ] Read-only / signed-out: **Apply** is disabled with an explanation; no repo write occurs and the
      suggestion stays local. **Dismiss** drops the suggestion but keeps the thread open.
- [ ] Schema/merge: `suggestion` decodes strictly (optional, unknown fields rejected) and is
      back-compatible when absent; the replacement is immutable once set (conflict = corruption) and
      `appliedAt` is a terminal transition (earliest wins on a double-apply).

### AI-suggested edits (added 2026-08-28, PR #63)

- [ ] On a thread with feedback comments and no suggestion yet, an **AI: draft a fix** action appears
      only when `VITE_SUGGEST_ENDPOINT` is configured; it POSTs a read-only `{ original, feedback,
      docTitle }` payload and, on success, attaches an **AI-provenance** suggestion (`origin: 'ai'`).
- [ ] The AI suggestion renders via the **same #35 diff + Apply** UI (no divergent write path); the
      diff label reads "AI-suggested change" (vs "Suggested change" for a human one), and Apply
      resolves + saves exactly as #35 does.
- [ ] Graceful degradation: with no endpoint the action shows a clear note (no crash, no repo write);
      an HTTP/network error or an unchanged/empty replacement is reported and no suggestion is set.
- [ ] Provenance persists: `suggestion.origin` decodes as `human`/`ai` only (unknown rejected) and
      merges immutably (conflicting provenance = corruption); read-only/signed-out still can't Apply.

## Identity And Mentions

- [ ] New-comment and reply composers use the same picker.
- [ ] Full name, alias/login, and email search terms survive spaces, dots, and a second `@`.
- [ ] Graph results resolve to tenant/object keys and GitHub results to global node IDs.
- [ ] Friendly names display without replacing stable identity keys.
- [ ] No candidate is auto-selected; ambiguity remains visible.
- [ ] Editing a selected mention token removes its resolution.
- [ ] A literal email such as `maya@example.com` produces no mention or notification.
- [ ] No resolver mail/UPN, provider token, or derived address appears in persisted JSON.
- [ ] Waiting-on uses stable key intersection for identity-aware comments and
      `authorLogin ?? author` only for legacy comments.

## Review Summary (AI, added 2026-08-28, PR #30)

- [ ] The **Summarize** button in the Review Status panel produces a grouped, readable digest
      (Blockers / Open questions / Suggestions / Decisions & resolved) of the current threads.
- [ ] The digest honors the active filter scope: everything-but-`All` summarizes open threads;
      `All` also surfaces resolved threads under Decisions.
- [ ] Zero threads shows a friendly empty message; a resolved-only doc in `open` scope reports
      no open threads.
- [ ] Summarizing mutates nothing and persists nothing — thread/sidecar data is unchanged and no
      network write occurs beyond the optional read-only AI POST.
- [ ] With no `VITE_SUMMARIZE_ENDPOINT` configured (default), the digest is generated locally and
      badged "Generated locally"; when configured but the call fails, it falls back to the local
      digest with a clear note (never throws, never blocks the review flow).
- [ ] The AI payload contains only what the panel already shows (bodies, intents, resolved,
      mentions) — no resolver mail/UPN, identity secrets, or provider tokens.

## AI-Readiness Score (added 2026-08-28, PR #44)

- [ ] The **Assess readiness** button in the Review Status panel grades the current document,
      showing a letter grade, a 0–100 score, a ready / needs-work / not-ready label, and an
      ordered gap list (critical → important → minor).
- [ ] Assessing mutates nothing and persists nothing — thread/sidecar/document data is unchanged
      and no network write occurs beyond the optional read-only AI POST.
- [ ] With no `VITE_READINESS_ENDPOINT` configured (default), the assessment is computed by the
      local rubric and badged "Graded locally"; when configured but the call fails, it falls back
      to the local rubric with a clear note (never throws, never blocks the review flow).
- [ ] An empty / near-empty document returns a friendly single "Document is empty" result, not a
      wall of gaps.
- [ ] The AI payload contains only `{ docTitle, markdown }` — no identity secrets or provider tokens.
- [ ] **Discuss** on an anchored gap opens a draft review thread at the offending span (severity →
      intent: critical=blocking, important=suggestion, minor=question) via the normal
      create/persist/notify path; the button then reads "Thread created". Gaps without an anchor
      (or when the viewer cannot comment) show no Discuss action.

## AI Reviewer Pass + REVIEW.md policy (added 2026-08-28, PR #43/#89)

- [ ] The **Run AI review** button drafts anchored findings for the current document, each tagged
      with a pass (bugs/security/compliance), a severity (important/nit), and an intent, plus a
      rationale and the quoted span. Findings are clearly marked draft ("nothing is saved or
      notified until you Accept").
- [ ] The pass itself mutates nothing and notifies no one — findings are ephemeral component state.
      **Accept** promotes a finding to a real thread via the normal create/persist/notify path
      (intent preserved; a finding with a proposed fix creates a #35 suggestion, `origin: 'ai'`).
      **Dismiss** discards it. Nothing auto-resolves.
- [ ] With no `VITE_REVIEW_ENDPOINT` configured (default), a **deterministic local pass** still runs
      (placeholders, vague terms, ambiguous scope, plaintext secrets) badged "Local pass"; when
      configured but the call fails, it falls back to the local pass with a note (never throws).
- [ ] A repo-root **REVIEW.md** on a GitHub source governs the pass: only listed passes run, findings
      are ranked Important→Nit, nits beyond the cap collapse to a "+N more" count, and excluded
      tokens drop matching findings. Absent REVIEW.md → the built-in default policy (badged
      "default policy"); the active policy is disclosed on the panel.
- [ ] The AI payload is read-only `{ docTitle, markdown, policy }` — no identity secrets or tokens.
      AI findings whose quote is not found in the document are skipped (findings must anchor).

## Thread Deep Links (added 2026-08-28, PR #32)
- [ ] Each open/resolved thread card exposes a **Copy link** action that copies a URL carrying a
      `thread=<id>` param (plus the document's source params for GitHub/Azure sources, or a bare
      same-origin `?thread=` for the built-in sample). The button shows transient "Link copied".
- [ ] Opening a `?thread=<id>` deep link loads the document normally, then focuses the matching
      thread. Its card gains the `active` class; navigation scrolls minimally to reveal the pair
      when it fits, otherwise prioritizing the card/header. Already-visible content is not recentered.
- [ ] The thread param only *activates* a thread — it never changes which document loads, bypasses
      source resolution/auth, or mutates/persists anything.
- [ ] A missing, orphaned, or deleted thread id degrades gracefully: the document still renders and
      a status notice explains the link could not be found — the app is never left blank.
- [ ] Deep links work for GitHub canonical targets (`?targetVersion&target&thread`), other providers
      (`?source&doc&thread`), and the sample (`?thread`).

## Persistence And Concurrency

- [ ] `a/b.md` and `a__b.md` map to distinct v2 paths.
- [ ] Spaces are canonical uppercase percent-encoding; NFC/NFD names remain distinct.
- [ ] Empty, dot, dot-dot, raw-backslash, and malformed paths are rejected.
- [ ] V2 is authoritative; v1 is read-only and accepted only on exact decoded `docPath` match.
- [ ] Unknown schema versions, malformed spans/routes/keys, and local-only remote comments fail.
- [ ] Concurrent comments union by ID; same-ID immutable differences fail as corruption.
- [ ] Resolution, intent, and anchor clocks merge independently.
- [ ] Deletion is a terminal tombstone; stale replies/mutations do not resurrect it.
- [ ] Reactions round-trip through decode/merge: concurrent reactions from different reactors
      union; a toggled-off reaction (removal tombstone) is not resurrected by a concurrent copy of
      the add; a reaction added after a remote deletion tombstone is rejected as stale.
- [ ] Legacy comments without a `reactions` field still decode cleanly; unknown reaction emoji, a
      non-identity-key reactor, a duplicate (emoji, reactor) pair, `removed` ≠ true, and unknown
      reaction fields are all rejected by strict decode.
- [ ] Reaction emoji survive the storage round-trip on both platforms (GitHub UTF-8 blob and Azure
      DevOps UTF-8 base64) — the persisted JSON re-decodes with the emoji intact.
- [ ] Repository saves serialize per document and retry CAS conflicts at most twice.
- [ ] Azure Repos writes use the loaded branch-tip `oldObjectId` with no hidden latest-tip read.
- [ ] GitHub writes create a commit from the expected head and update the branch ref non-forced.
- [ ] A GitHub sidecar save self-heals a non-fast-forward (HTTP 422) by re-reading the real branch
      tip and rebuilding the commit onto it; "Auto-save failed … not a fast forward" only surfaces
      after the bounded retries are exhausted.
- [ ] Serialized GitHub sidecar saves reuse the caller's own last-committed tip as the next base
      (GitHub's ref read lags behind just-written commits), so the multiple saves one comment
      triggers do not produce a non-fast-forward 422 storm; the cached tip is dropped on a genuine
      external conflict so the next attempt re-reads.

## Notifications

- [ ] Only exact, still-matching resolved spans can create dispatch recipients.
- [ ] GitHub node ID resolves to the current login and remains a repository collaborator.
- [ ] Issues are enabled and the caller has issue-write permission before dispatch claim.
- [ ] Immutable comment core is accepted remotely before `pending -> attempted` CAS.
- [ ] Provider call happens once only after the durable attempt claim.
- [ ] Delivered/failed/uncertain preserves attempt ID and never auto-retries.
- [ ] GitHub issue content contains only the mention, reviewer, and review link, not source quote
      or comment body.
- [ ] Unsupported provider/source mode saves locally and performs no outbound notification.

### @mention email relay (added 2026-08-26, PR #22)

- [ ] A resolved mention emails its recipient through `/api/notify` for **every** provider
      (ADO work items and GitHub), since ADO mentions resolve to Entra identities that carry
      an email but no ADO descriptor.
- [ ] The email fires from the **original resolved** mentions, even when the comment is stored
      `local-only` (e.g. a read-only source) and its persisted mention was downgraded to
      `unresolved` — emailing needs no repository write access.
- [ ] A mention that was emailed is **not** also reported as "unverified … was not notified" in the
      status line.
- [ ] Resolving an @mention requires an interactive Microsoft sign-in from the picker (Graph); the
      picker search re-runs automatically after sign-in so the verified directory result appears.
- [ ] The picker's "Sign in to search your Microsoft directory" prompt appears **even when a local
      suggestion already matched** (e.g. the viewer's own name, or someone already on the thread),
      so a name that matches a local candidate is never silently limited to an Unverified mention
      that notifies no one. The "no matches" message still only shows when there are truly none.
- [ ] A self-mention (the viewer @mentioning their own handle) emails the viewer via the relay on
      **both** ADO and GitHub — using the viewer's own Microsoft email (Azure/ADO sign-in login) —
      matching resolved or unresolved mentions of the viewer's handle, and is not reported as "not
      notified". GitHub's native issue @mention still posts but never emails the author (no double
      email).
- [ ] On a GitHub document, when the viewer is signed into Microsoft, the mention picker also
      surfaces directory (Entra) people **in addition to** GitHub collaborators, so a mentioned
      person can be emailed via the relay even without a corroborated GitHub public email (e.g. EMU
      accounts, and self-mentions that GitHub would not email). When NOT signed into Microsoft the
      GitHub picker is unchanged (collaborators only). The GitHub and Entra candidates stay distinct
      identities (no unverified github↔mail link is asserted); the email remains transient.
- [ ] The mention's email/contact is transient (mention-contact cache) and never appears in the
      persisted review JSON — the strict v2 mention schema keeps its exact key set.
- [ ] GitHub-native mentions (no resolver email) still notify via GitHub and are not double-emailed.
- [ ] The dev middleware and the SWA `api/notify` function both filter recipients through
      `NOTIFY_ALLOWED_DOMAINS` (default `microsoft.com`); external addresses are dropped and the
      webhook is not called when nothing remains.
- [ ] `sendMentionEmail` never throws — an undelivered send surfaces in the status line only.

### Notification center + Teams (added 2026-08-28, PR #31)

- [ ] The bell shows an accurate unread count of the viewer's **mentions**, **replies** on threads
      they participated in, and **assignments** (threads currently waiting on them). At most one
      row per comment (assignment > mention > reply).
- [ ] The viewer's **own** comments never produce a notification (no self-notifications), and
      deleted threads are excluded.
- [ ] Clicking an item focuses the exact thread (activates it and scrolls the highlight) and marks
      that item read; "Mark all read" clears the badge. Read/unread state is local-only and
      survives reload.
- [ ] The bell is disabled with an explanatory title when the viewer has no signed-in identity
      (Signed-Out Boundaries): no inbox is derived without an identity key.
- [ ] Teams delivery is **opt-in** (`VITE_TEAMS_NOTIFY=on`) and only delivers when the relay's
      `TEAMS_WEBHOOK_URL` is configured; it reuses `/api/notify` and enforces the **same**
      `NOTIFY_ALLOWED_DOMAINS` allowlist — external recipients are dropped and the Teams webhook is
      not called when nothing remains (no open relay).
- [ ] A request **without** a `teams` field behaves exactly as the email path did before (relay
      back-compat); `sendTeamsNotification` never throws.

## Source Resolution And Auth

- [ ] Slash-containing GitHub refs resolve with encoded and ordinary URLs.
- [ ] Branch/tag collisions show an explicit chooser; no longest-prefix guess occurs.
- [ ] Canonical GitHub targets round-trip through `targetVersion=1&target=...` and reverify.
- [ ] GitHub tag/commit sources are local-only; only branches are writable.
- [ ] Azure Repos missing version resolves the provider default branch before keying.
- [ ] Project-less work-item URLs resolve `System.TeamProject` before keying.
- [ ] ADO `203 text/html` is classified as `signin-required`, never parsed as JSON.
- [ ] Unconfigured hosted Azure sources say access is unavailable and do not make doomed calls.
- [ ] GitHub OAuth requests fixed scopes `repo read:org`.

## ADO Work Items (added 2026-08-26, PR #20/#21)

- [ ] Editing and saving a work-item doc reconciles to the **live** `/rev` before the optimistic
      `test /rev` op, so a review-save that bumped the revision does not 412-hang the save
      (`VS403351`). The "Save your edits" dialog closes on success.
- [ ] A doc save preserves any hidden review marker already in `System.Description` — editing the
      body never silently drops a `description`-mode review.
- [ ] A doc save retries once on a `409/412` revision conflict, then surfaces the error.
- [ ] The two ADO review stores — **Attached file** (default) and **Discussion** — each round-trip a
      v1 whole-file snapshot; switching modes needs a reload to read a review stored under a
      different mode. There is no "Description" store option; a stale `description` value in
      localStorage falls back to Attached file.
- [ ] Discussion mode writes a **single** DocThread-managed work-item comment that is human-readable
      (each thread shows its anchored text and comments), **updated in place** on save so the
      discussion is not spammed with a new comment per auto-save; the exact payload rides along in a
      hidden `display:none` marker for lossless round-trip.
- [ ] The review marker is a `display:none` `<div>` (ADO strips HTML comment nodes) and is stripped
      from the rendered doc body, so the base64 payload is never visible to users.
- [ ] ADO reviews use the dedicated v1 store (`loadAdoReview`/`saveAdoReview`), never the strict
      repo-only v2 dispatch pipeline; ADO comments persist with a display-name (or Entra) author.
- [ ] Loading a work item still works over the `az`/proxy transport even when Graph MSAL is on and
      the user has not completed an interactive Microsoft sign-in.
- [ ] Enabling `graph=msal` must not block ADO authoring: with `ado=dev-cli` the `az` identity stays
      the ADO author (comment/edit stay enabled, account slot shows it, no stray "Sign in with
      Microsoft"); the MSAL token is requested on demand only for people search.

## Device Flow

- [ ] The code renders in the current tab before any external navigation.
- [ ] Copy is an explicit button and reports success/failure.
- [ ] Open GitHub is an explicit button; a blocked tab leaves a direct link visible.
- [ ] Countdown, waiting state, cancel, expiration, and new-code behavior work.

## Signed-Out Boundaries

- [ ] Signed-out/sample comments are `localOnly`, have no stable author key, and unresolved mentions.
- [ ] Local-only comments cannot enter a remote sidecar.
- [ ] Signed-out users cannot resolve/reopen, delete remote threads, or edit remote sources.
- [ ] A thread created entirely in the local-only workspace can be discarded locally.

## Deployment And Release

- [ ] SWA pipeline, Azure pipeline template, and deploy script agree on Graph `msal`, explicit
      client/tenant, and ADO `off`.
- [ ] Upload artifact contains only the device-code/token Functions and the domain-allowlisted
      `notify` Function.
- [ ] Legacy live secrets/settings are removed.
- [ ] Updated analyzer is rolled out to every content repository before v2 data lands.
- [ ] `.docthread-reviews/ado/` is absent from HEAD and the compatibility fixture is synthetic.
- [ ] History purge evidence covers every ref, fork disposition, protections, collaborators, and
      GitHub Support cleanup. Until checked, production release is blocked.
- [ ] Issue #15 authorization/storage requirements pass before hosted ADO collaboration is enabled.

## Local Development And Tooling (added 2026-08-26)

- [ ] Before `npm ci`, stop the dev-server process tree (Vite **and** its `esbuild` child), or
      Windows fails with `EPERM: unlink ...\esbuild.exe` because the binary is still locked.
- [ ] Run the full gate on every change: `npm ci` → `npx tsc --noEmit` → `npm test` →
      `npm run build` (with ADO transport `off` to mirror production).
- [ ] Enabling Graph locally is `.env.local` only (`VITE_GRAPH_TRANSPORT=msal` plus the public
      client/tenant IDs); no committed-code change. The Entra SPA app registration must list the
      dev redirect URI (`http://localhost:5173/`).
- [ ] `.env.local` (webhook secret, `NOTIFY_ALLOWED_DOMAINS`, transports) is never committed.

Last updated: 2026-08-26.