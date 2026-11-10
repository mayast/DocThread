# Issue 128 Implementation Handoff

Status: implemented, automated validation passed; live and human validation gates remain before release or closure.
Owner: Robin Sacek (`rosacek_microsoft`). Updated: 9 September 2026.
Code review: [PR #141](https://github.com/gim-home/DocThread/pull/141).
Issue status: [#128, implemented-needs-validation](https://github.com/gim-home/DocThread/issues/128).

## Scope And Location

- Branch: `issue/128-review-first`, based on `6bd519f7bb7f4db117adae4a385cd31538265b6b`.
- Local worktree: `.worktrees/issue-128-review-first` inside the original checkout. The original
  `main` merge and its `.gitignore` conflict are untouched. The owner authorized committing/pushing
  this branch, updating the issue status and opening a PR after the automation pass. Merging and
  deployment still require approval.
- Preview: `http://localhost:5178/`. This is the local development app, not a deployment.
- The [9 September scope](https://github.com/gim-home/DocThread/issues/128) and
  [coordination comment](https://github.com/gim-home/DocThread/issues/128#issuecomment-5599272468)
  remain the contract. The owner's later design refinements keep the existing Primer styling,
  expose all three intent labels without definitions, avoid unnecessary disclosure, separate
  utilities from frequent actions, and show whole threads where the viewport permits.
- The owner approved continuation of the documented recovery/async reliability work after reviewing
  the initial UX implementation. No new backend, review-schema fields, authorization model, provider
  endpoints or notification dispatch order were introduced. ADO response failures now propagate;
  its existing native snapshot codec and the existing thread conflict rules are reused for recovery.
  #33 and other linked features are not bundled.

## Changed Files

| File | Purpose |
| --- | --- |
| [App.tsx](../src/App.tsx) | Tools/source control placement, rail composer, session hint, source-bound UI outcomes, input guards/export and passage navigation. |
| [CommentGutter.tsx](../src/components/CommentGutter.tsx) | Direct filter/search/sort, contextual actions and utilities, controlled reply drafts, copy fallback and optional AI command relocation. |
| [ShareModal.tsx](../src/components/ShareModal.tsx) | Access wording, input retention, copy fallback, request-acceptance wording and existing invitation participation. |
| [MentionEditor.tsx](../src/components/MentionEditor.tsx) | Presentational listbox wrappers correct the accessible option hierarchy without changing identity behavior. |
| [Dialog.tsx](../src/components/Dialog.tsx) | Native modal lifecycle, Escape and focus return for the existing modal workflows. |
| [reviewUi.ts](../src/reviewUi.ts) | Transient feedback outcome ordering and unsent-input decisions; no persistence format. |
| [reviewRecovery.ts](../src/reviewRecovery.ts) | Source-keyed browser Markdown recovery in the existing v1 envelope; local ADO copy loading/comparison and explicit combination. |
| [ado.ts](../src/ado.ts) | Exposes the existing native snapshot codec and surfaces failed discussion/attachment HTTP outcomes. Same routes, auth and payloads. |
| [reviewPersistence.ts](../src/reviewPersistence.ts) | Extracts the existing thread-combination loop for explicit ADO recovery; repository validation, CAS and conflict/tombstone rules remain. |
| [styles.css](../src/styles.css) | Reading-mode page flow, existing-token control grouping, composer placement and responsive fixes. No replacement theme. |
| [sample.ts](../src/sample.ts) | Current instructions, plain categories and factual save/notification wording, with valid sample anchors. |
| [reviewUi.test.ts](../tests/reviewUi.test.ts) | Twenty focused tests for source-bound operations, outcomes, drafts, sample anchors, ADO-copy combination and read/write failure handling. |
| [reviewUi.fixture.js](../tests/reviewUi.fixture.js) | Fail-closed browser fixtures for provider/save/recovery checks; not shipped in the bundle. |
| [reviewRecovery.browser.js](../tests/reviewRecovery.browser.js) | Repeatable browser scenarios for keyboard/layout, drafts, suggestion safety/provenance, and both ADO review stores. |
| [test-browser.mjs](../scripts/test-browser.mjs), [CI workflow](../.github/workflows/ci.yml) | Command-line three-engine runner, isolated previews, network guard, WCAG A/AA axe scans and retained evidence. |
| [package.json](../package.json), [package-lock.json](../package-lock.json) | Focused `pretest` and `test:browser` commands; pinned development-only Playwright and axe packages from the configured proxy. No production dependency changes. |
| [README.md](../README.md), [regression checklist](REGRESSION-CHECKLIST.md), [architecture](architecture.md), [providers/identity](providers-and-identity.md), this file | Current controls, browser recovery, actual notification evidence, verification criteria and remaining gates. |
| [UI evidence directory](prototypes/128-ui/) | Actual local-app before/after screenshots listed below. Maya's original assets are unchanged. |

## AC Evidence

These are implementation and local-verification results, not user acceptance or live-provider passes.

| AC | Local evidence | Remaining gate |
| --- | --- | --- |
| AC1 Core journey | Real React selection/composer posting, reply, resolve/reopen and canonical thread links exercised with the fail-closed GitHub fixture. Foreground native word selection, arrow-key intent selection and local posting also passed. Tools remains secondary; Reply/Resolve are contextual. | Uncoached reviewer trial on an authorized document. |
| AC2 Access | Signed-out and tag-ref fixtures retain local feedback and disable shared mutations. Private 403 keeps the requested URL, shows recovery and never activates a sample thread. Share explicitly grants no access. | Real private-account/permission combinations and local ADO credentials. Hosted ADO remains disabled. |
| AC3 Persistence | Provider-shaped fixture covers confirmed shared save, exhausted non-fast-forward conflict, retry, held save, local-storage failure, draft apply versus source commit, and failed/accepted invitation request. Source/version ordering has unit coverage. | Real provider receipts and notification observations. Email service acceptance is not mailbox delivery. |
| AC4 Draft safety | Source-bound recovery survives reload and requires explicit restore after access. Editor exit/source switching retain drafts. A suggestion cannot overwrite an unapplied draft, and reverting to source clears only the matching old recovery copy. Both ADO stores preserve local and concurrent shared additions through explicit local reconciliation. All seven browser groups pass in three engines. | Credentialed provider verification remains. Unposted comments/replies are session-only with reload warning/export; cleared or unavailable browser storage cannot guarantee recovery. |
| AC5 Low friction | Plain visible Question/Suggestion/Blocking, unchanged default. One session hint disappears after successful comment posting. Sample instructions and exact unique anchor quotes have tests. | Reviewer trial without coaching. |
| AC6 Recoverability | Thread/share clipboard rejection reveals selectable fallback; failed invite retains fields. Applied-draft and local/AI-origin labels do not claim source write or approval. Canonical-link failure does not focus another source's thread. | Live clipboard/browser/provider coverage; anchor recovery follows existing behavior. |
| AC7 Accessibility/layout | Chromium, Firefox and WebKit pass keyboard selection/posting, 390 px and 200% CSS zoom scenarios. Forty-two axe scans cover final views plus composer, editor, source-save, draft, leave and ADO-recovery dialogs with zero WCAG A/AA violations. Focus containment/return and passage navigation also have foreground checks. | Actual screen-reader output and browser-native zoom/hardware observation remain unverified. Automated scans do not prove usability for assistive-technology users. |
| AC8 Non-regression | Existing source/schema/merge/notification/editor/AI tests plus focused recovery tests and browser checks cover read-only, local, authorized, failure and recovery paths. No schema, permission, transport, dispatch ordering or CAS policy changes. ADO error checks now reject failures previously ignored. | Credentialed provider matrix, configured remote AI/Graph/Teams, uncoached trial and post-deployment smoke. |

## Verification

- `npm ci` uses the configured package proxy. Pinned browser/accessibility packages are development-only;
  matching browser builds come from the standard Playwright distribution.
- `npx tsc --noEmit` equivalent project compiler invocation passed during the increments.
- Final clean-install gate: 20 focused tests and 287 existing tests passed (307 total), plus the
  PowerShell content-installer suite. TypeScript and the production build passed.
- `npm run test:browser` passed all 7 scenario groups in Chromium, Firefox and WebKit (21 runs),
  with 42 WCAG A/AA axe scans, zero violations and zero unexpected or escaped provider requests.
  The CI workflow runs the same command as a three-engine matrix and retains screenshots/reports.
- `npm run build` passed with `github=public-only graph=off ado=off`. Existing dynamic-import and
  bundle-size warnings remain; they were not a reason for an unrelated bundling refactor.
- Production build rejection checks passed for Graph MSAL without client configuration and
  hosted ADO `dev-cli` enablement.
- Browser assertions ran against the actual development app using [the fixture](../tests/reviewUi.fixture.js),
  not the HTML mockup. The fixture handles the existing request shapes and rejects unrecognized
  provider/external calls. Assertions recorded zero unexpected fixture requests.
- No real provider writes, source commits, invitations or notifications were performed by these
  checks. Expected 404/409/422 console entries are the simulated missing-sidecar/conflict responses.
- Early integrated-browser runs sometimes reported hidden tabs and stale screenshot paints. Those
  images were replaced using a visible Playwright browser, matched light theme and CSS-pixel viewports,
  and completed animation frames. Before screenshots were recaptured from an untouched temporary
  worktree at the base commit; that worktree and its server were removed afterward.

### Reproducing Browser Scenarios

Use an available Playwright browser context, install the fixture with
`page.addInitScript({ path: '<worktree>/tests/reviewUi.fixture.js' })`, and open the local app with
`?ui-check=authorized&doc=https%3A%2F%2Fgithub.com%2Fexample%2Freview-ui%2Fblob%2Fmain%2Fdocs%2Freview.md`.
The test identity and repository are synthetic. `window.docThreadTest` exposes only fixture data.
Use a fresh context or a new synthetic repo name to avoid mixing local reviews between scenarios.

Fixture modes include `signed-out`, `private-denied`, `conflict`, `hold-save`, `document-failed`,
and `email-accepted`. Change `window.docThreadTest.mode` to inject a failure/retry; `hold-save`
exposes `releaseSave()` when a simulated ref write is pending. A `v1` tag URL exercises read-only
behavior. Check `unexpected` stays empty. Fixture installation is mandatory before navigating;
ordinary development mode otherwise uses the machine's existing CLI identity.

The Node tests run through `npm test`. For the browser gate, run:

```powershell
npx playwright install chromium firefox webkit
npm run test:browser
```

[test-browser.mjs](../scripts/test-browser.mjs) starts two isolated preview processes on available
loopback ports, one ADO-off and one local `dev-cli`. It does not change the normal preview or
production configuration. Each scenario uses a fresh fixture context plus a network-level guard
that rejects external and unhandled provider requests. Both servers and browsers close when the
run finishes. `DOCTHREAD_TEST_BROWSERS=chromium` or `--browser=chromium` selects one engine.

[reviewRecovery.browser.js](../tests/reviewRecovery.browser.js) exports the existing scenario
function; it can also be imported by another Playwright host. The seven scenario groups cover
keyboard/narrow/zoom, document reload/access/cleanup, reverting edits, source-switch drafts,
suggestion draft safety/provenance, ADO attachment, and ADO discussion. Additional intermediate
scans cover the interactive dialogs and composer/editor. Reports/screenshots are generated in
`node_modules/.cache/review-ui/` and uploaded as `review-ui-<engine>` CI artifacts.

### Engineering Review Outcomes

The automation pass reproduced and fixed these issues with behavior regressions or axe evidence:

- Applying a suggestion could overwrite an unapplied document draft; it now remains unavailable
  with a specific explanation until that draft is handled.
- Applying a suggestion omitted its AI/skill provenance; all existing suggestion metadata is retained.
- Undoing back to source text left an obsolete browser draft; matching-draft cleanup removes it.
- Mention listbox wrappers, the document-editor accessible name, and branch-name contrast in the
  green source-save button failed accessibility checks; narrow semantic/contrast fixes passed.

No new review-state meanings, styling framework or production dependency was added by this pass.

## UI Evidence

Same local app and sample workflow, captured signed out without provider writes. After images
include the updated sample instructions, so this is functional UI evidence, not a pixel-only test.

| View | Before | After |
| --- | --- | --- |
| Desktop, 1440 x 1000 | [Before](prototypes/128-ui/implementation-before-desktop.png) | [After](prototypes/128-ui/implementation-after-desktop.png) |
| Mobile entry, 390 x 844 | [Before](prototypes/128-ui/implementation-before-mobile.png) | [After](prototypes/128-ui/implementation-after-mobile.png) |
| Mobile discussion | Former nested rail: 310 px viewport / 1370 px content | [Whole thread and controls](prototypes/128-ui/implementation-after-mobile-thread.png) |
| Markdown recovery after reload | No durable draft recovery | [Current source and recovered draft](prototypes/128-ui/implementation-recovery-draft.png) |
| ADO failed-save recovery | Stored review previously replaced local feedback on load | [Local and saved feedback copies](prototypes/128-ui/implementation-recovery-ado.png) |

Long documents/discussions require page scrolling. No claim is made that an arbitrary number of
comments can fit one viewport. The aim is no unnecessary clipping of a short, complete thread.
Recovery images are actual application views using synthetic GitHub/ADO fixtures, not live accounts.

## Approved Recovery Follow-Up

1. **Markdown recovery implemented:** browser key `docthread:document-draft:<canonical source key>`
  contains the existing v1 review envelope with empty threads and exact Markdown. No new schema
  field or source-side payload is used. Recovery is offered only after the source loads with the
  current viewer's access, never automatically applied or published. Empty/corrupt/foreign drafts,
  stale cleanup and storage failure have tests. Clearing browser data or using another browser
  cannot recover that copy; exports remain available.
2. **ADO reconciliation implemented:** the local work-item snapshot uses the existing native decoder,
  including name-based authors. Differing copies are preserved; Combine feedback locally reuses
  the existing immutable-core, clock and tombstone rules and cannot silently choose a winner.
  Save review remains explicit. Both attachment and discussion stores pass failed-save/reload,
  concurrent-addition recovery and failed-read retry fixtures. This does not add a new ADO
  server-side concurrency protocol or change the existing whole-snapshot storage model.
3. **Async source affinity implemented:** notification operations capture source, key, feedback,
  revision and version before awaiting. A delayed operation cannot cancel a newer autosave or
  borrow a later source. Late saved-sidecar adoption merges with retained local data. Dispatch
  ordering, recipient checks, allowlists and attempt-state transitions are unchanged.
4. **Delivery evidence remains limited:** relay acceptance is not a mailbox delivery receipt.
  UI labels the observable response; adding receipts or changing sequencing is outside #128.

## Next Action And Authority

Robin reviews the completed UX and approved recovery changes, then supplies an authorized disposable
document/work item and test reviewers for live validation. No provider write target was nominated;
fixture coverage must not be reported as a credentialed provider trial.
The PR is for code review; keep #128 labelled `status:implemented-needs-validation` and open.
Resolve the original checkout's unrelated merge before any local integration; the implementation
worktree was created specifically to avoid changing it. PR creation is authorized; merge/deployment are not.

Before release/closure: rerun the required gates after any fixes, observe screen-reader output and
browser-native zoom, run
credentialed provider checks, conduct the uncoached trial with non-technical reviewers (including
who-can-see-feedback comprehension and the proposed under-five-minute first shared comment target),
and obtain approval for deployment. Capture post-deployment smoke evidence afterward.

Implemented and locally tested does not mean deployed, live-verified, or user-validated. Local AC4
recovery evidence is present; the remaining live and human completion gates are still open.
No merge, deployment, issue closure or human-validation claim is authorized by automated results.
