import type { Thread } from './types';

// The built-in sample: a self-explanatory user manual for DocThread, pre-loaded
// with example review threads so a first-time visitor immediately sees how a
// review looks and how to create their own. It is clearly labeled as sample
// content and never touches a real repository.
export const SAMPLE_DOC = `# 📘 DocThread — User Manual & Guided Tour

> **This is sample content — a safe playground.** Nothing here touches a real repository. Highlight a sentence, leave a comment, reply, resolve, edit, and explore. This page doubles as your user manual — read on, or jump straight in.

## What DocThread does

DocThread brings Word-style inline review to Markdown files and Azure DevOps work items. Reviewers highlight rendered text and start threaded discussions right where the content lives — no pull-request detours and no exporting to Word and back. Technical and non-technical reviewers collaborate in one place, on a single source of truth.

## Bring your own document

Choose **Tools > Open document**. Paste a GitHub file link, an Azure Repos file link, or an Azure DevOps work item link and choose **Open**. Source access still applies. Read-only sources keep new feedback in this browser; sharing a link does not grant access.

## Leave your first comment

1. **Select any text** in this document.
2. The composer opens in **Comments**, with the selected quote. Type your feedback.
3. Choose **Post comment**. The feedback-save status reports where it was saved.

Give it a try: highlight this sentence and leave a comment of your own.

## Comment intents

Question, Suggestion and Blocking are available directly in the composer. Question is the default; changing it is optional.

**Suggest an edit** adds an exact replacement for the selected text.

## Mention people and notify them

Type an @ followed by a name, alias, or email, then pick a directory identity from the list. Notification outcomes are reported separately from feedback saves. A configured mention-email relay can send a request even for local-only feedback; request acceptance does not confirm recipient delivery.

## Reply and resolve

Choose **Reply** beside a thread, then **Post reply**. **Resolve** and **Reopen** stay beside the discussion. Resolved threads are available under **Show > All**. **Show passage** returns to the anchored text when its location is available.

## Edit the document and save your changes

Choose **Tools > Edit document** to edit Markdown in place. Formatting, spell-check and Editor / Split / Preview remain available. **Apply draft** updates the document in this tab and opens the source-save choices:

- **GitHub or Azure Repos** — commit straight to the writable branch, or open a **pull request** for the change.
- **Azure DevOps work item** — update the work item description directly.
- **Keep in this tab** — no source write. The status reports whether a recovery draft was saved in this browser. After reopening the same source, **Compare draft** offers the saved text without replacing the source automatically.

Remote editing requires source write access. Feedback saves separately: a sidecar next to a Git file, or an **attached file** or **discussion** for a locally enabled ADO work item. Failed saves remain visible with recovery actions.

**Exit editor** retains an unapplied draft. Unposted comments and replies stay with their source when you switch documents in the same tab. They are not saved across a page reload; **Inspect / export** provides a recovery copy. If local and saved ADO feedback differ, **Compare feedback** keeps both copies available before any new save.

## Find comments

The comments rail shows **open**, **blocking** and **waiting on you** counts. Search, **Show** and **Sort** are directly available there:

- **Open** — active, unresolved threads (the default view).
- **Question / Suggestion / Blocking** — filter by the recorded label.
- **Mine** — threads currently waiting on your identity.
- **Needs re-anchor** — threads with an uncertain or missing text location.
- **All** — everything, including resolved threads.

Each filter shows a count. **AI Review** and **Summarize review** are under **Tools**. Optional REVIEW.md / skill inputs are available in the AI review panel. **Share** contains the review link and invitations.

## Explore the examples

The colored highlights already on this page are example threads. Open each one on the right to see a question with a reply and an @mention, a suggestion, a blocking issue, and a resolved thread — then start your own review above.

## Good to know — current limitations

So expectations are clear, here is what DocThread does **not** do yet today:

- **Co-review is asynchronous, not live.** Multiple people can review the same document and their comments are saved to a shared store, but you see others' new comments when you **load or reload** the document — not in real time as they type. There is no live presence or shared cursors yet.
- **Sharing your comments needs write access.** If you can't write to the source (a read-only collaborator, or signed out), you can still read everyone's shared comments, but your own additions stay **local to your browser** until you have write access.
- **Hosted access is GitHub-only for now. Azure DevOps work items work only from localhost.** On the deployed site, Azure Repos and Azure DevOps work-item review are turned **off** — pasting an ADO work-item URL shows _"Azure DevOps work item access is not configured on this deployment."_ To review ADO work items, run DocThread **locally** (\`VITE_ADO_TRANSPORT=dev-cli\`, using your own \`az\` identity). Enabling hosted ADO access is tracked in [#115](https://github.com/gim-home/DocThread/issues/115).

Real-time co-review, presence, and broader hosted access are on the roadmap — see the project README's Plan, [issue #41](https://github.com/gim-home/DocThread/issues/41) (live co-review), and [issue #115](https://github.com/gim-home/DocThread/issues/115) (hosted ADO) for details.
`;

// Pre-marked example review. Each thread anchors to an exact, unique phrase in
// SAMPLE_DOC so the anchor engine locates it with high confidence. Together they
// demonstrate the four states a reviewer will encounter: an open question with a
// reply and an @mention, a suggestion, a blocking issue, and a resolved thread.
const anchor = (quote: string) => ({ quote, prefix: '', suffix: '', start: 0 });

export const SAMPLE_THREADS: Thread[] = [
  {
    id: 'sample-question',
    intent: 'question',
    resolved: false,
    createdAt: '2026-08-20T17:02:00.000Z',
    anchor: anchor('Select any text'),
    comments: [
      {
        id: 'sample-question-c1',
        author: 'Priya (Reviewer)',
        body: 'This is a Question thread. Does the highlight follow the text if the author edits the document later? @maya',
        createdAt: '2026-08-20T17:02:00.000Z',
        // Seeded so the reactions feature (#37) is visibly demonstrated in the
        // guided tour even before you sign in (issue #104).
        reactions: [
          { emoji: '👍', by: 'github:sam-pm', byName: 'Sam (PM)', at: '2026-08-20T17:25:00.000Z' },
          { emoji: '🎉', by: 'github:priya-reviewer', byName: 'Priya (Reviewer)', at: '2026-08-20T17:26:00.000Z' },
        ],
      },
      {
        id: 'sample-question-c2',
        author: 'Maya (Author)',
        body: 'Yes — DocThread re-anchors comments when the text changes, and flags anything it can no longer place so nothing is silently lost.',
        createdAt: '2026-08-20T17:14:00.000Z',
      },
    ],
  },
  {
    id: 'sample-suggestion',
    intent: 'suggestion',
    resolved: false,
    createdAt: '2026-08-20T17:20:00.000Z',
    anchor: anchor('Question, Suggestion and Blocking'),
    comments: [
      {
        id: 'sample-suggestion-c1',
        author: 'Sam (PM)',
        body: 'Could the selected quote stay visible while I write my comment?',
        createdAt: '2026-08-20T17:20:00.000Z',
      },
    ],
  },
  {
    id: 'sample-blocking',
    intent: 'blocking',
    resolved: false,
    createdAt: '2026-08-20T17:31:00.000Z',
    anchor: anchor('feedback-save status'),
    comments: [
      {
        id: 'sample-blocking-c1',
        author: 'Priya (Reviewer)',
        body: 'Which source will receive this feedback?',
        createdAt: '2026-08-20T17:31:00.000Z',
      },
    ],
  },
  {
    id: 'sample-resolved',
    intent: 'question',
    resolved: true,
    createdAt: '2026-08-20T16:40:00.000Z',
    anchor: anchor('Paste a GitHub file link'),
    comments: [
      {
        id: 'sample-resolved-c1',
        author: 'Sam (PM)',
        body: 'Does this work with a private repository?',
        createdAt: '2026-08-20T16:40:00.000Z',
      },
      {
        id: 'sample-resolved-c2',
        author: 'Maya (Author)',
        body: "Yes — sign in and DocThread uses your own access, so you only see documents you're already allowed to read. Marking this Resolved — notice how it stays visible but moves aside.",
        createdAt: '2026-08-20T16:52:00.000Z',
      },
    ],
  },
];

// A stable fingerprint of the sample content (doc text + example anchors). It
// changes automatically whenever the sample document or its threads change, so a
// persisted sample review that was saved against an older version can be
// discarded instead of being shown with stale, orphaned anchors ("text changed").
export const SAMPLE_VERSION: string = (() => {
  const material = SAMPLE_DOC + '\u0000' + JSON.stringify(SAMPLE_THREADS.map((t) => t.anchor));
  let hash = 5381;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  }
  return 's' + (hash >>> 0).toString(36);
})();
