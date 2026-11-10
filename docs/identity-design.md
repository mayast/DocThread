# Identity, autocomplete and friendly names — MVP design

Status: **design final — not implemented.** No code, issue or deployment changes have been made.
Covers issues [#12](https://github.com/gim-home/DocThread/issues/12),
[#13](https://github.com/gim-home/DocThread/issues/13),
[#14](https://github.com/gim-home/DocThread/issues/14), and the directory-backed people picker
that resolves a typed name, alias or email to a real identity.

---

## 1. Why three bug reports and a feature are one piece of work

They read as three unrelated bugs. They are three symptoms of one gap: **DocThread has no
identity model.** It has strings that look like identities and functions that guess at the
rest.

| Issue | Restated as an identity problem |
|---|---|
| #12 | The app can't tell you *you are nobody yet* — it reports a parser error instead |
| #13 | *Becoming somebody* is a maze the target audience won't complete |
| #14 §4 | The app *invents* who other people are, and emails document text to the invention |

Fixing them separately means writing the same missing concept three times, slightly
differently. Fixing the model first makes all three small — and makes the fourth thing
possible: a **people picker** that resolves a typed name, alias or email to a real directory
identity, which is what every Microsoft enterprise tool has trained these reviewers to expect.

That feature is also why the model has to come first rather than being bolted on. Autocomplete
over a guessing function would simply produce wrong identities faster.

The audience constraint decides the whole design. DocThread exists so non-technical
stakeholders can review documents. Every one of these failures lands hardest on exactly that
person, mid-review, in someone else's tool.

---

## 2. The model

A subject groups one or more provider-asserted identities; notification routing remains a
separate provider-specific reference.

```ts
// src/identity.ts
export type IdentityAuthority = 'github' | 'entra' | 'azure-devops';

export interface ProviderIdentity {
  key: string;
  authority: IdentityAuthority;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  /** B2B hint from the UPN shape; not an authoritative userType. */
  externalHint?: 'b2b-guest';
}

export interface IdentitySubject {
  /** Selected/source authority key; immutable after the mention is created. */
  subjectKey: string;
  /** Sorted provider keys used for equality; may grow before persistence only. */
  linkedKeys: string[];
  displayName: string;
  identities: ProviderIdentity[];
}

export type NotificationRoute =
  | { kind: 'github'; nodeId: string }
  | {
      kind: 'ado-work-item';
      organization: string;
      identityId: string;
      descriptor: string;
      originId: string;
    }
  | { kind: 'none' };

/** Runtime-only search result; evidence is captured in closure, not exposed as data. */
export interface SearchCandidate {
  readonly subject: IdentitySubject;
  secondaryLabel(): string | undefined;
  assertedMailEquals(other: SearchCandidate): boolean;
  toMentionReference(span: MentionSpan, route: NotificationRoute): MentionReference;
}

declare function makeSearchCandidate(
  subject: IdentitySubject,
  evidence: { mail?: string; userPrincipalName?: string; assertedBy: IdentityAuthority }
): SearchCandidate;
```

Stable keys are concrete and provider-scoped:

| Authority | Key |
|---|---|
| GitHub | `github:<nodeId>` — login can be renamed; example `github:U_example` |
| Entra | `entra:<tenantId>:<objectId>` |
| Azure DevOps | `azure-devops:<organization>:<descriptor>` |

The real ADO probe matters here: Maya's ADO descriptor and ADO identity ID are **not** her
Graph object ID. The ADO Graph record exposes that Graph ID as `originId`, but relabelling a raw
ADO descriptor as an Entra key would silently join unrelated namespaces.

Parsed legacy text is **not** a `ProviderIdentity`; it is an unresolved mention. Verification is
field- and route-specific: Graph can assert a person and UPN without asserting a mailbox; ADO
can assert a native mention route without supplying GitHub identity. A single global
`confidence` flag cannot model those truths.

Only `ProviderIdentity`, `IdentitySubject`, `MentionReference`, and `NotificationRoute` cross the
persistence boundary. `makeSearchCandidate` captures mail/UPN evidence in closure and exposes no
serializable evidence property; generic object spread/`JSON.stringify` can see only the durable
subject and methods are omitted. Persistence builders accept a `MentionReference`, never a
`SearchCandidate`.

### The rules that fall out of it

**R1 — Only a provider-asserted identity with a valid native route may trigger notification.**
This closes #14 §4 by construction. We stop being able to notify an identity we invented,
because we stop inventing identities. `loginToEmail`'s `alias_tenant` → `alias@tenant.com`
derivation is deleted, not allowlisted.

**R2 — Custom email is disabled in the secure MVP.**
The existing relay is anonymous and forwards arbitrary client-supplied recipients and HTML.
Adding a domain allowlist would close one exploit but leave an internal mail relay. Native
provider notifications are the MVP; R9 defines the exact conditions for email to return later.

**R3 — Resolver-derived email is never persisted as identity metadata.**
Sidecars are committed to Git and read by people who may not be signed in, may not have ADO
access, and may be offline or on the built-in sample. So the display name must be captured at
write time. Email may be held transiently for search and exact cross-provider linking but is
never copied into `ProviderIdentity`, `IdentitySubject`, `MentionReference`, dispatch metadata,
or author metadata. An address in Git history is a durable PII leak with no revocation.
Display names and stable provider IDs are also personal data; repository access and retention
policy therefore apply to sidecars, even though the highest-risk field is omitted.

Comment bodies are user-authored content and may themselves contain a literal email address.
DocThread does not block or silently redact that prose. It persists exactly like any other
comment text, never becomes a resolved mention or notification destination, and the UI does not
imply otherwise. Organizations that forbid email addresses in review text need a separate
content/DLP policy; that is not identity resolution.

This guarantee covers DocThread-controlled persistence, logs, telemetry, deep links, and error
messages — not provider access logs. Graph `$search` and ADO `filterValue` are GET APIs, so a
typed email/UPN necessarily appears URL-encoded in an HTTPS request URL visible to Microsoft
Graph/Azure DevOps and browser network tooling. DocThread never logs that URL, strips query data
from telemetry, keeps `Referrer-Policy: strict-origin-when-cross-origin`, and does not proxy the
directory query through its own backend. If provider URL logging is unacceptable, email search
must be disabled; there is no POST equivalent in the chosen APIs.

**R4 — Unresolved mentions still work as mentions.**
`@bob` that resolves to nobody still renders, still sets waiting-on, still shows in the gutter.
It does not notify, and the UI says so: *"@bob — unresolved, not notified."*
Silence here is the failure mode `src/mentions.ts` already warns about.

**R5 — Identity equality uses stable keys; provider links require a provider assertion or exact
verified mail.** Within one authority, keys compare directly. ADO `originId` → Entra object ID
is an explicit provider assertion and is stronger than mail. Otherwise, cross-provider identities
link only when both provider-asserted `mail` values are non-null and equal after
case-insensitive normalization. Never match on alias prefix or UPN. In the live repo all 12
GitHub collaborators expose public EMU mail and two sampled members matched Graph exactly, but missing mail
degrades to "not linked", never to a guess.

**R6 — Search the provider you are going to mention into.**
On a GitHub document, search repository collaborators through GitHub. On `azure-repos` and
`ado-workitem` sources, search Entra through Microsoft Graph. The visible handle is presentation
only; the stable key owns assignment and waiting-on. In particular, a Graph result does **not**
natively provide an "ADO alias" — the UI may display the UPN local part, but routing may not use
that derived text.

The notification channel splits the same way, which is what makes this work:

| Document | Handle from | Notified by | Address needed |
|---|---|---|---|
| GitHub | GitHub repository collaborators | GitHub issue mention | **none** |
| ADO work item, delegated ADO access | Graph + exact ADO identity confirmation | Native ADO work-item mention | **none** |
| ADO work item without delegated ADO access | Graph | None; assignment persists with an explicit warning | **none** |
| Azure Repos file | Graph | None in the secure MVP; assignment persists | **none** |
| Built-in sample / signed out | Local seed set | None | **none** |

GitHub **notification** never needs an email address; it routes by revalidated node ID/current
login. Email input to the picker is separate and best-effort: transient Graph mail is joined to
transient public GitHub profile mail, and fails closed when either side is absent.

**R7 — A typed email address is a search term, never a destination.**
This is the rule that stops autocomplete from reopening #14 §4. Typing
`maya.stewart@contoso.example` submits that string to the directory as a *query*. If the directory
returns a match, we use the identity the directory returned. If it returns nothing, the mention
stays unresolved and nothing is sent. **An address the directory does not know can never
receive mail.** A picker that accepted free-typed addresses would be the original bug with a
nicer interface.

**R8 — `mail` is a mailbox assertion; UPN is not. Never auto-select among duplicates.**
Both halves of this rule come from probing the live tenant (§3), and both were wrong in the
previous draft.

*The address.* `mail` and `userPrincipalName` are different values and only `mail` is a mailbox:

```
displayName        Maya Stewart
mail               Maya.Stewart@contoso.example  <- mailbox assertion
userPrincipalName  mayast@contoso.example        <- sign-in identifier, not a mailbox
```

Note what this says about the deleted `loginToEmail`: its `alias_tenant` → `alias@tenant.com`
guess produced the *UPN* form. It routes in this tenant by luck, not by design. Never copy UPN
into `mail`, never use it for exact-mail linking, and never use it as an email destination. A
null `mail` simply means there is no mailbox assertion; the identity and an ADO-native route may
still be fully verified.

*The duplicates.* One human commonly has several directory objects. A sanitized version of the
live result shape is:
against the live tenant returns three:

| displayName | mail | userPrincipalName |
|---|---|---|
| Maya Stewart | `Maya.Stewart@contoso.example` | `mayast@contoso.example` |
| Maya Stewart | `maya.personal@example.net` | `maya_example.net#EXT#@contoso.onmicrosoft.com` |
| Maya Stewart (NON EA SC ALT) | `sc-example@contoso.example` | `sc-example@contoso.example` |

A corporate account, a **guest account pointing at a personal mailbox**, and an admin alternate.
Picking the second sends internal document text to an outlook.com address — #14 §4's exact
outcome, reached this time through a *correctly functioning* directory lookup. A verified
address is not automatically the right address.

Therefore: rank guests below members, never auto-select when several results share a display
name, and always show `mail` as the secondary line so the human resolves the ambiguity.
`User.ReadBasic.All` does **not** expose `userType` or `accountEnabled`, so guest detection uses
the `#EXT#` marker in the UPN as a **heuristic** — no extra permission required. Label it
"Possible guest" rather than "External". Absence of the marker proves nothing; the picker still
shows the mailbox on every result and never auto-selects. Authoritative `userType` classification
would require a broader permission and buys no routing safety now that custom email is disabled.

**R9 — Native provider notification first; custom email fails closed.**
Today `/api/notify`, the Vite handler, and the Worker `/notify` route are anonymous raw-body
forwarders. The live SWA has `NOTIFY_WEBHOOK_URL` configured. CORS does not authenticate a
caller, and the client supplies arbitrary recipients, subject, and HTML. A domain allowlist
alone would stop external-domain exfiltration but leave an internal spam/impersonation relay.

The secure MVP therefore does this:

- GitHub source: post a minimal GitHub issue mention to a verified repository collaborator.
- ADO work item with delegated ADO write access: post a minimal native comment using the
  documented Markdown syntax `@<{adoIdentityId}>`. A read-only live lookup verified that an
  exact UPN search returns an active ADO identity and Graph `originId`.
- Azure Repos, ADO proxy mode, sample, or signed-out state: persist the assignment but send no
  outbound message; state that plainly in the UI.
- Disable the existing custom relay and remove `NOTIFY_WEBHOOK_URL` from the live SWA before
  release. This is the immediate mitigation for #14 §4.

Direct email can return later only behind a token minted for a DocThread API audience (not a
Graph or ADO token), validated issuer/audience/scope, exact server-side domain allowlisting,
bounded recipients and payload sizes, server-generated subject/body, and a content-minimal
template containing only "you were mentioned" plus the review link. That is a separate feature,
not a loophole in this MVP.

Removal is end-to-end, not just a client call deletion:

| Surface | MVP action |
|---|---|
| `api/notify/index.js`, `api/notify/function.json` | Delete so SWA packages no route |
| `vite.config.ts` | Remove local notify middleware |
| `worker/index.js` | Remove `/notify`; keep only GitHub device-flow routes |
| `src/auth.ts` | Remove `NOTIFY_ENDPOINT` |
| `src/github.ts`, `src/App.tsx` | Remove direct-email types, HTML builder, sender, and call path |
| `.env.example` | Remove `NOTIFY_WEBHOOK_URL` and `VITE_ADO_EMAIL_DOMAIN` |
| `infra/logicapp.json` | Remove from MVP infrastructure; keep future design in history, not deployable IaC |
| `src/sample.ts`, README, deployment docs, regression checklist | Remove claims that custom email is available |
| `tests/oauth-api.test.mjs` | Replace notify-degradation test with a package/route-absence guard |
| Live SWA `docthreadr8k2m1` | Delete `NOTIFY_WEBHOOK_URL` before deploying the new build |
| Cloudflare deployment, if present | Delete its `NOTIFY_WEBHOOK_URL` secret |

Build validation must assert that `dist`/`api` contains no notify function and Worker source has
no `/notify` branch. A client-only test is insufficient.

**R10 — Persist first; claim an at-most-once dispatch; never retry ambiguity automatically.**
The current code starts notification immediately and auto-saves 900 ms later. That can notify
for a comment which never persisted. GitHub and ADO do not accept a DocThread idempotency key,
so the honest guarantee is at-most-once **dispatch**, not exactly-once delivery.

```ts
interface NotificationDispatch {
  channel: 'github' | 'ado-work-item';
  state: 'pending' | 'attempted' | 'delivered' | 'failed' | 'uncertain';
  /** Sorted subject keys included in this provider call. */
  recipientKeys: string[];
  attemptId?: string;
  attemptedAt?: string;
  providerUrl?: string;
  errorCode?: string;
}

interface ImmutableCommentCore {
  id: string;
  author: string;
  authorLogin?: string;
  authorIdentityKeys: string[];
  body: string;
  createdAt: string;
  mentions: MentionReference[];
}
```

Flow:

1. Build a canonical immutable core: sort key sets, order mentions by span, and serialize a
  fixed-field object. Keep that original core in the originating tab's memory.
2. CAS-save the core and `dispatch.state = 'pending'`.
3. Reload the accepted remote revision and deep-compare its complete core — author, key sets,
  body, times, spans, subjects, provider identities, and routes — to the in-memory original.
  Comment ID/body alone is insufficient.
4. Revalidate the selected route immediately before claim:
  - GitHub: resolve persisted node ID to the current login; query repository collaborators by
    that login and require the same node ID; recheck Issues enabled and viewer issue-write.
  - ADO: require the selected active ADO identity, Graph `originId`, work-item project, and the
    current delegated write token. Never derive login/ID from the displayed handle.
5. CAS-transition `pending → attempted`, adding `crypto.randomUUID()` and timestamp. This is
  the dispatch claim; no background process replays `pending` automatically.
6. Call the provider once. Best-effort CAS the result to `delivered`, definitely-not-sent
  `failed`, or response-lost/timeout `uncertain`.
7. Retry is out of MVP. Never transition `failed`/`uncertain` back to `attempted`; show the
  provider/review link so the reviewer can contact the assignee manually.

A crash after the claim and before the provider call can lose a notification; that is the cost
of the at-most-once choice. It is safer than duplicate or unpersisted notifications for this MVP.
No later tab dispatches a persisted `pending`/`attempted` record.

---

## 3. The people picker

Type a name, alias or email; get the real person.

```ts
interface IdentityResolver {
  readonly authority: 'github' | 'entra';
  currentSubject(): Promise<IdentitySubject | null>;
  resolveKey(key: string): Promise<SearchCandidate | null>;
  /** Type-ahead over display name, alias and email in one call. */
  search(term: string, signal: AbortSignal): Promise<SearchCandidate[]>;
}
```

The reviewer types any of three forms — `Maya`, `mayast`, `maya.stewart@contoso.example` — and gets
the same person. This is the behaviour every Microsoft enterprise tool has trained them to
expect, so anything less reads as broken.

Backed by the security-context cache defined below; positive and negative results are in-memory
only, so a typo'd mention does not re-query on every keystroke.

### Entra — Microsoft Graph `User.ReadBasic.All`

> **This reverses an earlier decision in this document.** The first draft chose the ADO Identity
> Picker specifically to avoid a tenant-admin consent conversation, and asserted that Graph
> "needs `User.ReadBasic.All` and therefore admin consent". **That assertion was wrong.**
> Checked against the Microsoft Graph permissions reference:

| Permission | Delegated `AdminConsentRequired` |
|---|---|
| `User.Read` | **No** |
| `User.ReadBasic.All` | **No** |
| `User.Read.All` | Yes |

`User.ReadBasic.All` returns exactly the fields a people picker needs, and nothing else:

```
displayName · givenName · surname · mail · userPrincipalName · id · photo · securityIdentifier
```

Display name, both name parts for the surname-prefix ranking, the address, the UPN and a photo.
It is a GA, fully documented API, and the permission is scoped so narrowly that it cannot read
job titles, managers, group membership or anything else.

```http
GET https://graph.microsoft.com/v1.0/users
      ?$search="displayName:maya" OR "mail:maya" OR "userPrincipalName:maya"
  &$count=true
      &$select=id,displayName,givenName,surname,mail,userPrincipalName
      &$top=10
ConsistencyLevel: eventual
```

Use `URLSearchParams` rather than hand-built escaping. `$search` is an advanced query: send
`ConsistencyLevel: eventual`, include `$count=true`, and treat a guest-caller authorization
denial as `directory-unavailable` rather than "no matches". The `#EXT#` marker is a B2B-guest
**hint** for ranking/warning, not an authoritative external-user classification.

**Why this is now preferred over the ADO Identity Picker**, which the earlier draft chose:

| | Graph `User.ReadBasic.All` | ADO Identity Picker |
|---|---|---|
| Consent | User-consentable by definition | Needs the ADO resource token |
| That token's scope | — | `user_impersonation`, documented **high privilege**: *"grants full access to Visual Studio Team Services REST APIs… consent with caution"* |
| API status | GA, documented | Preview route; model confirmed, route not |
| Fields | Exactly the picker's needs | Broader than needed |

The original rationale was "full type-ahead with no new consent". It is now clear the Identity
Picker asks for **more** consent, not less — the narrow directory read is the smaller ask, and
the high-privilege ADO scope is the larger one. Choosing it was an error of assumption.

**Consequence worth stating plainly: the picker no longer depends on ADO access at all.** It
works on GitHub documents, on ADO documents, and while the ADO scope is still unapproved.

*Kept as a possible later refinement, not MVP:* the Identity Picker's `operationScopes:
['ims','source']` also tells you who actually has access to that ADO organisation, which Graph
cannot. If "only people who can open this work item" filtering is ever wanted, that is where it
comes from. It costs nothing extra on an ADO document, where the ADO token is already held to
read the work item.

### Exact ADO identity confirmation for native mentions

Graph identity and ADO identity are separate namespaces. For a work-item source with delegated
ADO access, confirm the selected Graph result through the stable Identities API:

```http
GET https://vssps.dev.azure.com/{org}/_apis/identities
  ?searchFilter=General
  &filterValue={userPrincipalName}
  &queryMembership=None
  &api-version=7.1-preview.1
```

Accept exactly one active `User` whose
`properties["http://schemas.microsoft.com/identity/claims/objectidentifier"]` equals the
selected Graph object ID. Then retain both keys and the returned ADO `id`.

This was measured for two real accounts; identifiers in this document are redacted. The
work-item `IdentityRef` ADO ID and its ADO Graph record's `originId` are different provider keys,
and `originId` exactly matched the selected Graph object ID.
The opaque `aad.…` descriptor itself decodes to a different GUID, so **never decode it and call
the result an Entra object ID**.

The official ADO API mention form is:

```markdown
@<{adoIdentityId}>
```

Posting it as a work-item comment produces the provider-native email. The notification comment
contains only the mention and DocThread link, not the document quote or review text. Do this
only with the reviewer's delegated ADO write token. Do **not** post through the current shared
PAT proxy: #15 establishes that it does not yet enforce per-work-item caller authorization.

### The minimal Entra app registration

Everything the picker needs, and nothing that requires an administrator:

```
Application: DocThread
  Platform:      Single-page application  (auth code + PKCE, public client, no secret)
  Redirect URIs: https://<swa-host>/           (hosted)
                 http://localhost:5173/        (dev)
  Delegated permissions:
    Microsoft Graph → User.ReadBasic.All   AdminConsentRequired: No
```

`openid profile` are runtime OIDC scopes. On the v2 endpoint they provide the ID token and
viewer object ID without `User.Read`; DocThread never calls `/me`. The redundant `User.Read`
permission was removed from the created registration after this pressure test.

Additive, and **only** needed for direct ADO work-item/Azure Repos operations and native ADO
notification — not for the picker:

```
    Azure DevOps → user_impersonation      high privilege; expect an admin ask
```

Two caveats that decide whether this is actually self-service in *your* tenant:

1. **User consent must be enabled.** `AdminConsentRequired: No` is a property of the
   permission, not a promise about the tenant. Entra ID → Enterprise applications → Consent and
  permissions can be set to *"Do not allow user consent"*, in which case even this permission needs an
   admin. Check that setting before promising a self-service rollout.
2. **App registration may be restricted.** Many tenants set *"Users can register applications"*
   to No.

Neither is something the app can design around. Both are one-line questions to a tenant admin,
and both are far smaller asks than consent to a high-privilege scope.

### Measured against the live tenant, 2026-08-23

Probed against tenant `72f988bf-…` (Microsoft corporate) as the signed-in work account. These are
observations, not assumptions:

| Check | Result |
|---|---|
| `defaultUserRolePermissions.allowedToCreateApps` | `true` — users may register apps |
| Assigned user-consent policy | `ManagePermissionGrantsForSelf.microsoft-user-default-low` |
| Graph permissions classified `low` in this tenant | `openid`, `profile`, `email`, `offline_access`, **`User.Read`**, **`User.ReadBasic.All`** |
| Therefore | **the one Graph API permission this design needs is self-consentable here — no admin** |
| `$search` picker query | Works with the Azure CLI Graph token; returns `displayName`, `givenName`, `surname`, `mail`, `userPrincipalName`, `id` |
| Alias / display name / email as input | All three resolve to the same person with that token |
| DocThread SPA PKCE token | **Proven:** scopes `User.ReadBasic.All` plus OIDC `openid profile email`; no `User.Read` |
| Least-privilege `$search` | **Proven:** the signed-in alias returned exactly the expected identity and fields |
| Conditional Access during probe | No claims challenge for this account/session on 2026-08-23; future policy can still change |

The first two query rows used the CLI's broad token; the PKCE rows are the discriminating proof
that the registered app's single Graph permission is sufficient. The probe also caught a useful
protocol detail: SPA authorization-code redemption requires a cross-origin `Origin` header.
MSAL supplies it in-browser; non-browser test harnesses must do so explicitly.

**One governance gate the public docs do not mention.** Creating the application fails with:

```
ServiceTreeValueMissing: ServiceManagementReference field is required for Create,
but is missing in the request.
```

This tenant requires every new registration to carry a **Service Tree ID**. It is an ownership
decision, not a technical one — the value must identify the service that owns DocThread, and
cannot be guessed. Record it in the deployment docs as a prerequisite, because it will block
anyone repeating this setup and the error message does not suggest where to obtain one.

### The registration, as created

Registered 2026-08-23 under the **PM Copilot** service tree entry:

| | |
|---|---|
| Display name | `DocThread` |
| Application (client) ID | `3a9dd418-f26a-4e43-b3bb-30a5c89b251a` |
| Object ID | `7971b34d-f2f7-418f-ae11-4eb0262ac379` |
| Service principal | `b8ee4426-8649-4545-b684-3263ed2cefa1`, enabled |
| Service Tree | `2f8f2dca-b2ce-411d-9b9f-20da3845086b` (PM Copilot) |
| Sign-in audience | `AzureADMyOrg` — single tenant |
| Platform | SPA (auth code + PKCE) |
| Redirect URIs | `http://localhost:5173/`, `https://wonderful-water-098ab6803.7.azurestaticapps.net/` |
| Credentials | **none** — public client, no secret, nothing to rotate or leak |
| Delegated permissions | `User.ReadBasic.All` only; request `openid profile` at runtime |

`VITE_AZURE_CLIENT_ID` is a **public** value. It ships inside the SPA bundle by design and is
not a secret; treating it as one causes the transcription errors #14 §3 warns about. Copy it as
text.

**What is proven.** The registration exists, is correctly shaped, requests one user-consentable
Graph permission, completes SPA PKCE, and executes the real directory query with that permission
alone. No administrator or client secret was involved.

The production app still needs explicit transport controls for local verification. Today both
`azureAuth.ts` **and** `providers.ts` branch on `import.meta.env.DEV`; changing one would still
route ADO through the Vite proxy with a broad CLI token.

### Conditional Access — no, and don't design as if there were a way

**You cannot register an app that is exempt from Conditional Access.** There is no such flag.
CA is evaluated at token issuance against the user, the target resource and the client, and per
Microsoft's developer guidance it "can be applied to the app, but also can be applied to a web
API your app accesses", and "an enterprise customer can apply and remove Conditional Access
policies at any time". Single-page apps using MSAL.js are named explicitly as an affected type.

CA is also **not a differentiator between the two backends** — Graph and ADO are both reached
with an interactive Entra token, so both inherit whatever policy applies. It was never a reason
to prefer one.

What the app must do instead is comply:

- **Handle the claims challenge.** A CA step-up arrives as `error=interaction_required` plus a
  `claims` parameter. That value must be passed back into the next `acquireTokenPopup` /
  `acquireTokenRedirect`. Without it, `acquireTokenSilent` fails forever and the reviewer sees a
  permanent, unexplained sign-in loop.
- **Prefer redirect over popup for interrupts.** MFA, device-compliance and terms-of-use
  interrupts frequently fail inside popups. `azureAuth.ts` currently uses `loginPopup` and
  `acquireTokenPopup` throughout; a redirect fallback is needed.
- **Expect device-compliance policies to be the common failure.** A browser SPA on an
  unmanaged device is the realistic break, and it is not fixable in code.
- **Classify it correctly.** A CA failure is `signin-required` with its own message — not
  `forbidden`, and certainly not a parse error. This is the same typed-error work as #12, and it
  is why that classification table needs a row for it.

### Authentication is capabilities, not one mode

The current `AZURE_AUTH_MODE` conflates "a Microsoft account exists" with "this app may call
Azure DevOps". That becomes actively wrong with the new Graph-only registration: merely setting
`VITE_AZURE_CLIENT_ID` changes the mode to `entra`, after which `azureAuth.ts` requests Azure
DevOps `.default` even though the app has no ADO permission.

Represent identity and transport independently:

```text
VITE_GRAPH_TRANSPORT = off | msal | dev-cli
VITE_ADO_TRANSPORT   = off | direct-msal | dev-cli | hosted-proxy
```

`dev-cli` is a convenience mode, never a least-privilege proof. `msal` goes directly to the
real service and exercises this app registration. `hosted-proxy` applies only to work items;
Azure Repos has no hosted proxy.

Derive capabilities from the resolved transports and actual token/permission result:

| Capability | Hosted prerequisite | Token audience |
|---|---|---|
| Microsoft identity + people search | client ID + tenant ID | Microsoft Graph |
| ADO work item through enterprise proxy | **disabled until #15** | none in browser |
| Direct ADO work items / Azure Repos | explicit ADO-delegated enablement + permission | Azure DevOps |
| GitHub source and review store | GitHub OAuth | GitHub |

Rules:

- Never infer direct ADO capability from the presence of an Entra client ID.
- The current work-item proxy and shared snapshot store are not production capabilities; #15
  must replace them with per-item ADO authorization before they can be enabled.
- Azure Repos has no hosted proxy today; hide/disable it until direct ADO permission is enabled.
- Use separate `getGraphAccessToken()` and `getAzureDevOpsAccessToken()` methods and caches;
  access tokens for different resources are not interchangeable.
- Rename the account-level state to Microsoft/Entra auth. Derive source capabilities separately.
- `providers.ts` chooses base URL from `VITE_ADO_TRANSPORT`, never directly from `DEV`.
- Expose the resolved transports in diagnostics/UI so a broad CLI test cannot masquerade as
  production MSAL validation.

As measured, the live GitHub repository has no Entra, ADO proxy, or GitHub scope override
variables. The SWA has only `NOTIFY_WEBHOOK_URL`. Deploying the new client ID without this split
would therefore enable Graph **and break ADO direct calls**.

Deployment entry points must agree:

- `.github/workflows/deploy-swa.yml`, `templates/azure-repos/azure-pipelines-swa.yml`, and
  `scripts/deploy-swa.ps1` all set `VITE_GH_SCOPE='repo read:org'`.
- They expose `VITE_GRAPH_TRANSPORT` and `VITE_ADO_TRANSPORT`; absent values resolve to `off`,
  never from `DEV` or client-ID presence.
- The secure hosted MVP forces `VITE_ADO_TRANSPORT=off`; remove the `-AdoApiBase` parameter and
  `VITE_ADO_API_BASE` environment entry until #15.
- `scripts/deploy-swa.ps1` adds `-GraphTransport Off|Msal`. `Msal` requires a non-empty client
  ID and an explicit tenant GUID; the current generic `organizations` default is invalid for the
  single-tenant registration. `Off` emits neither Graph capability nor misleading sign-in UI.
- The deployed PM Copilot instance uses client `3a9dd418-f26a-4e43-b3bb-30a5c89b251a`, tenant
  `72f988bf-86f1-41af-91ab-2d7cd011db47`, Graph transport `msal`, and ADO transport `off`.
- A build prints the resolved, non-secret capability matrix and deployment smoke tests assert it;
  this catches a pipeline/script drift before upload.

**GitHub Pages is retired from the secure MVP.** `.github/workflows/deploy-pages.yml` consumes
the same repository variables but its origin is not registered on the single-tenant Entra app,
and it depends on a separately operated Worker. Disable its triggers/remove it from the release
path and update README/deployment docs to name SWA as the sole hosted target. Do not add the
Pages redirect URI merely to keep an untested second production topology alive. Reintroducing
Pages later requires its own redirect, explicit transports, Worker device-flow-only audit, and
the same capability/smoke gates as SWA.

### #15 is a release gate for hosted ADO work items

The current proxy proves only that the GitHub caller can access `REVIEW_REPO`, then uses a
shared PAT/bearer to GET/PATCH any allowlisted work item. The shared GitHub sidecar also stores
the full work-item Markdown snapshot, and `App.tsx` renders that snapshot when live ADO fetch
fails. Repository access is not work-item authorization.

Secure MVP behavior:

- Delete `api/ado-api/index.js` and `api/ado-api/function.json` from the deployed API package;
  an unset Vite variable does not disable an anonymous server route.
- Remove `VITE_ADO_API_BASE` from build workflows/templates and remove ADO-proxy setup from
  deployment docs until #15 replaces it.
- Remove live `ADO_PAT`, `ADO_BEARER`, and `ADO_ALLOWED_ORGANIZATIONS` settings if present.
  Remove `GH_SERVER_TOKEN` as well; the secure MVP has no server-token bridge.
- Remove the stored-Markdown fallback and do not read a work-item sidecar until live per-item
  authorization succeeds.
- Stop writing work-item Markdown or threads to the shared GitHub review repository.
- Do not enable `VITE_ADO_API_BASE` or advertise hosted work-item collaboration.
- Local `az`-authenticated work-item viewing may remain a development aid with localStorage
  only; it is not the hosted collaborative MVP.
- #15 must deliver a backend that authorizes every read/write against the caller's ADO identity,
  stores reviews outside a broadly readable Git repo, and exposes the CAS contract in §4.

Identity/picker work can proceed independently, but **hosted ADO work-item review cannot ship**
until that backend passes authorization tests.

Artifact validation fails the build if any `api/ado-api` Function, `/api/ado-api` route, proxy
setting, or hosted snapshot fallback remains. This is tested against the upload artifact, not
only source imports.

### Cache security context

The in-memory cache key is not just the normalized term:

```text
resolver | account-stable-key | tenant | source-scope | normalized-term
```

`source-scope` is `owner/repo` for GitHub, tenant for Graph, and organization for ADO
confirmation. Clear affected entries on sign-out, account/tenant switch, source switch, scope
reauthorization, or transport change. Every search captures a request generation; discard a
late result when its generation no longer matches even if `AbortController` failed to stop the
network response.

### GitHub

The global Search Users API is **not an EMU directory**. Live calls for
an exact EMU login, its friendly name plus `org:gim-home`, and its email all returned zero,
including
an exact raw REST call. Do not build the picker on it.

The repository collaborator connection is the authoritative search surface:

```graphql
repository(owner: $owner, name: $repo) {
  collaborators(first: 10, affiliation: ALL, query: $term) {
    nodes { id login name avatarUrl }
  }
}
```

Measured against `gim-home/DocThread`, one call resolves `maya`, `mayast`, and `Maya Stewart`
to `mayast_microsoft` / **Maya Stewart**. It returns global node IDs and friendly names for
all 12 collaborators, and GitHub GraphQL permits direct CORS from the deployed SWA origin.

Requirements and fallbacks:

- The caller needs repository write/maintain/admin **and** OAuth scopes `repo read:org`.
  GitHub documents already require write to commit their sidecar, but hosted device flow
  currently requests only `repo`; expand `VITE_GH_SCOPE`, detect `INSUFFICIENT_SCOPES`, and
  offer reauthorization for stale tokens.
- Search capability and notification capability are separate. Before issue notification, check
  `hasIssuesEnabled` and viewer issue-write permission. If unavailable, save the assignment and
  show "not notified"; never make sidecar persistence depend on Issues being enabled. The live
  repo measured `hasIssuesEnabled: true`, `viewerPermission: MAINTAIN`.
- The connection's `query` supports name and login, not email. For email input, Graph resolves
  the person, GitHub queries same-name collaborators, and `GET /users/{login}` supplies public
  profile email for an **exact** R5 join. All 12 current collaborators expose it; absence must
  produce "no GitHub match", never an EMU suffix guess.
- Delete `api/gh-api/index.js` and `function.json`, remove `VITE_GH_API_BASE` / `GH_SERVER_TOKEN`,
  and fail artifact validation if `/api/gh-api` is packaged. The current anonymous catch-all can
  execute any repository-scoped path with a more privileged server token after only a coarse
  caller check; that is privilege elevation, not a safe fallback.
- The secure MVP uses only the visitor's direct GitHub OAuth token. If org approval is missing,
  private GitHub search/read/write is unavailable and the UI degrades to public/local behavior.
  Do not bridge around the organization's OAuth policy with a server credential.
- Honor GraphQL rate-limit headers. The measured token had a 5,000-point limit; do not carry
  over the Search Users API's unrelated 30-request/minute number.

### Local seed set — free, and it makes the first keystroke instant

Adding `System.CreatedBy,System.AssignedTo` to `fetchWorkItem`'s `fields=` list yields verified
ADO identities for the two people most likely to be mentioned on that work item, for one string,
with no new scope and no consent. The live payload contains `id`, `descriptor`, `displayName`,
`uniqueName`, and avatar URL. It does **not** contain the Entra object ID; an exact ADO identity
lookup exposes that as `originId`, so raw descriptor and Graph ID remain separate keys.

Thread participants and these work-item identities form the immediate local seed set. GitHub
collaborators may be prefetched when authorized, but the picker does not depend on fetching an
entire large repository: the GraphQL connection filters server-side.

**Parse both identity shapes.** The selected live work item returned `IdentityRef` objects.
Legacy/string payloads such as `"Maya Stewart <mayast@contoso.example>"` remain a compatibility
case and must be treated as unverified until Graph or ADO confirms them. This is the same
defensive-parse lesson as #12.

### Ranking

Follow the Microsoft picker convention, because reviewers already have muscle memory for it:

1. Exact alias / login / email match
2. Prefix match on given name or surname
3. Substring match

Within each band: current document participants first, member accounts before `#EXT#` guests,
then stable provider order. Never auto-select, even one result; selection is the user's explicit
act that creates a resolved mention.

### Mechanics

- Fire at ≥ 2 characters, 250 ms debounce
- Opening `@` starts an explicit picker session. Keep that session while the user types spaces,
  dots, or the second `@` in an email address; close it on selection, Escape, newline, or when the
  caret moves before the trigger. The current backward scan stops at whitespace and at the
  second `@`, so it cannot satisfy name/email search.
- `AbortController` cancels the in-flight request on the next keystroke — the codebase already
  uses `AbortSignal` in `pollForDeviceToken` and both proxies
- Cache positive *and* negative results in memory only; clear identity data on sign-out
- Escape Graph `$search` syntax and cap the term length; user input is data, not query syntax
- Honor `429` / `Retry-After`; do not retry stale or aborted searches
- Three visually distinct states: **searching**, **results**, **no match**. "No match" must not
  look like "still searching" — that ambiguity is the #12 failure class wearing a new hat
- Show initials immediately and a secondary line (`mail` or login). GitHub avatar URLs can load
  directly; Graph photos require a separate authorized byte request, so they are lazy and
  optional, with object URLs revoked when results leave the list
- Implement one shared `MentionComposer` for new comments and replies, with combobox/listbox
  semantics, `aria-activedescendant`, arrow navigation, Enter/Tab selection, Escape dismissal,
  and focus returned to the original caret after selection

### Degradation — three tiers, all of them designed states

The picker must never be the reason a review can't proceed. `src/mentions.ts` deliberately
avoids a directory lookup today precisely so it "keeps the picker useful offline and on the
built-in sample". Adding a directory must not cost that.

| Situation | Picker offers | Notification |
|---|---|---|
| Signed in, provider reachable | seed set, then provider results | native provider path when its capability is present |
| Signed in, directory call fails/times out or guest caller is denied | seed set only, with *"directory unavailable"* | only identities already verified for that channel |
| Not signed in, or built-in sample | seed set only | none — nothing to notify from |

The seed set alone is never empty in practice: on a real document it holds the participants,
the work item's `CreatedBy` / `AssignedTo`, and the repo collaborators. A directory outage
degrades the picker's *reach*, not its function. Say which tier you're in rather than showing an
empty list — an unexplained empty picker reads as "this person doesn't exist", which is the #12
failure class again.

### What happens to the existing `src/mentions.ts`

Most of it survives. Recording the disposition so the picker is understood as an extension of
the existing module rather than a replacement for it:

| Existing | Fate |
|---|---|
| `mentionStyleFor`, `mentionStyleHint` | **Fix:** both `azure-repos` and `ado-workitem` are Entra-backed; today `azure-repos` incorrectly falls into GitHub style |
| `activeMentionQuery` | **Replace with a stateful session.** The current whitespace scan cannot accept a full name or email and treats the second `@` as a new trigger |
| `applyMention` | **Keep**, extended to record the chosen identity and exact text span |
| `mentionCandidates` | **Becomes the seed set**, extended with work-item identities and collaborators |
| `filterCandidates` | **Becomes ranking over the combined set.** Provider order is not the product contract; exact alias/email and participant priority are |
| `MentionCandidate.source` | **Extend** with `'github'`, `'entra'`, and `'azure-devops'`, so the picker can show provenance |
| `toMentionForm` | **Delete from resolved flow.** Its `bare.search(/[_@]/)` surgery is a guess. Keep a legacy-only normalizer under a name that says so |

The picker must be the same component in the new-thread popup **and** each reply box. Today the
reply textarea in `CommentGutter.tsx` has no autocomplete at all; shipping only the first
composer would leave the primary threaded workflow inconsistent.

---

## 4. Storage and the migration trap

The existing shape has a provider handle but no stable author identity:

```ts
interface Comment {
  author: string;        // becomes the display name — 'Maya Stewart'
  authorLogin?: string;  // legacy/provider handle — not stable across rename
  /** Present on comments created by the identity-aware client. */
  identityVersion?: 1;
  authorIdentityKeys?: string[];
  localOnly?: true;
}
```

Populate both identity fields on write; keep `author` as the denormalised display name (R3).

### Resolved mentions must be structured, not re-parsed

The picker resolves an identity. That resolution has to survive into storage — otherwise
notification routing falls back to regex-parsing untrusted comment text, which is precisely how
#14 §4 happened.

```ts
interface MentionSpan {
  /** UTF-16 offsets into the immutable comment body. */
  start: number;
  length: number;
  text: string;          // exact token, including '@'
}

export type MentionReference =
  | (MentionSpan & {
      kind: 'resolved';
      subjectKey: string;
      identityKeys: string[];
      displayName: string;
      handle: string;
      route: NotificationRoute;
    })
  | (MentionSpan & {
      kind: 'unresolved';
      handle: string;
    });

interface Comment {
  // …
  identityVersion?: 1;
  authorIdentityKeys?: string[];
  mentions?: MentionReference[];
  dispatch?: NotificationDispatch;
}
```

The body keeps plain `@handle` text — readable, greppable, and it still works when mirrored into
a GitHub issue comment. The structured list rides alongside it.

> **The routing rule: only a `resolved` entry whose span still exactly matches the body may
> trigger a notification.** `extractMentions` is demoted to legacy comments and unresolved
> waiting-on display. Text parsed out of a body never causes a send.

This is what makes the boundary bug below permanently harmless rather than merely fixed: even
if the regex still matched `@microsoft` inside an email address, that text yields no resolved
`MentionReference`, so no notification is possible. Fix the regex anyway — but it is the
architecture, not the regex, that closes the hole.

No resolver-derived email metadata or access token is persisted (R3). A selected identity lives in composer state;
before save, each span is checked with `body.slice(start, start + length) === text`. Editing or
deleting the token removes its resolution. Comments are immutable after submission, so the
stored offsets then remain stable.

### Schema v2 uses a new sidecar path

A stale v1 tab physically removes threads and always writes top-level schema 1. Optional fields
cannot make tombstones or dispatch claims safe. The enforceable cutoff is a **different file**:

| Source | Legacy, read-only | Identity-aware v2 |
|---|---|---|
| GitHub / Azure Repos | `.docthread/<lossy-flat>.json` | `.docthread/v2/<encoded path segments>.json` |
| ADO work item | `.docthread-reviews/ado/<flat>.json` | #15 backend; never Git |
| localStorage | `docthread:<legacy key>` | `docthread:v2:<base64url(canonical JSON)>` |

The v1 slash-to-`__` encoder is lossy: `a/b.md` and `a__b.md` collide. V2 never flattens and
never Unicode-normalizes: Git can contain distinct NFC and NFD filenames, so normalization would
create another collision. Use the provider-returned repository-relative path as the source of
truth, convert separators to `/` only for Azure/Windows inputs before provider resolution,
reject empty / `.` / `..` segments and raw backslashes, then UTF-8 percent-encode each raw
segment independently with canonical uppercase hex. Example: `docs/review notes.md` becomes
`.docthread/v2/docs/review%20notes.md.json`; `a/b.md` and `a__b.md` remain distinct.

Use two related identities. A repository sidecar travels through branch merges, so its persisted
identity is branch-relative; the runtime/local identity includes the selected ref:

```ts
type PersistedRepositoryIdentity =
  | { provider: 'github'; path: string }
  | { provider: 'azure-repos'; path: string };

type CanonicalSourceIdentity =
  | {
  provider: 'github'; owner: string; repo: string;
  versionType: 'branch' | 'tag' | 'commit'; ref: string; path: string;
    }
  | {
      provider: 'azure-repos'; organization: string; project: string; repo: string;
      versionType: 'branch' | 'tag' | 'commit'; ref: string; path: string;
    }
  | { provider: 'ado-workitem'; organization: string; project: string; id: number };
```

Repository sidecar addressing uses the resolved raw relative `path` because repository/ref are
already established by the authenticated fetch envelope. Persist and validate
`PersistedRepositoryIdentity`, deliberately omitting repository and `ref`; when a feature branch
or fork PR merges, the sidecar remains valid beside the same document. Runtime APIs and `localStorage` use
stable-key-ordered canonical JSON of `CanonicalSourceIdentity`, including ref/version. On load,
the decoder requires persisted provider/path equality and obtains repository/ref only from the
authenticated requested target. `docPath` is display/legacy metadata, never a storage key,
authorization input, or source of repository/ref rebinding.

The canonical-vector tests require composed and decomposed Unicode names to produce different
paths and round-trip to the exact original code-point sequence.

### Resolve source coordinates before keying

Parsed URLs are provisional inputs, not canonical identities:

- GitHub blob URLs do **not** provide an unambiguous ref/path boundary when a ref contains `/`.
  Resolve them under the contract below before v2 lookup. Blob paths retain their
  provider-returned code points.
- Azure Repos URLs may omit `version`. Resolve the repository's default branch through the Git
  repository API, then set `versionType: 'branch'` and concrete `ref`. If that lookup is not
  authorized, load may show a configuration/auth error but must not create a local or remote v2
  key under `ref: null`.
- ADO work-item URLs may omit project. Organization-level work-item GET is supported; request
  `System.TeamProject` and use its exact returned value as canonical `project` before any sidecar
  lookup, local key, or comments route. The live probe verified work item 1173530 resolves to
  project `Engineering`, and that the organization-only comments route is 404.
- Persist the branch-relative repository identity and keep the full canonical source identity in
  runtime/local storage. All later read/write/notification calls use the resolved runtime target;
  never recompute it from the original URL or the sidecar.

### GitHub ref and deep-link contract

Extend GitHub targets with an explicit version type:

```ts
interface GitHubSourceTarget {
  kind: 'github';
  owner: string;
  repo: string;
  versionType: 'branch' | 'tag' | 'commit';
  ref: string;             // full branch/tag name or 40-hex commit SHA
  path: string;
}
```

**Generated DocThread links never depend on parsing a blob URL.** `sourceDeepLink` emits
`targetVersion=1&target=<base64url(canonical target JSON)>`. Base64url is transport encoding,
not a signature; decode, shape-check, enforce size limits, resolve the exact ref, and verify the
file before use. Analyzer links use the PR head's 40-hex SHA with `versionType: 'commit'`.
External "Open on GitHub" links use the `html_url` returned by the verified Contents API.

Legacy `doc=<GitHub blob URL>` and pasted URLs use a read-only resolver:

1. Parse the **raw encoded pathname** before decoding segments.
2. If the single segment after `/blob/` contains `%2F`, decode it exactly once as the complete
   ref and treat the remaining segments as path. `%252F` remains literal `%2F`; encoded slash is
   rejected in path segments.
3. Otherwise enumerate every possible boundary in the tail. In one bounded GraphQL request,
   test each exact `refs/heads/<candidate>` and `refs/tags/<candidate>`; accept a commit candidate
   only when it is exactly 40 hexadecimal characters. Resolve each ref to commit SHA and verify
   the remaining path is a file at that SHA.
4. Zero candidates is an invalid link. One candidate becomes the canonical target. Multiple
   candidates show a chooser with type, full ref, path, and short commit; **never choose longest
   prefix or GitHub's implicit precedence**. Branch and tag with the same name are distinct.
5. Cap tail segments and candidate aliases (64) before network access; over-limit input is
   rejected rather than causing an unbounded API query.

Measured example: both
`https://github.com/microsoft/vscode/blob/BV/1.114/README.md` and the `%2F`-encoded ref variant
return 200 and refer to branch `BV/1.114`. The current fixed-segment parser reads `BV`, which is
therefore demonstrably wrong.

Writeability follows resolved type:

- `branch`: shared sidecar and source writes are allowed subject to provider permission and CAS.
- `tag` / `commit`: source and remote sidecar are read-only; comments remain local-only. Creating
  a review branch from an immutable ref is deferred, not done implicitly.
- If a branch/tag disappears or moves between resolution and write, fail the atomic ref update
  or re-resolve; never fall back to the default branch.

Rules:

- Add one central `decodeDocThreadFile(unknown)` used by every loader. No raw JSON cast.
- Read v2 first. If absent, read v1 as a legacy baseline. The first identity-aware write creates
  v2 and records `{ legacyPath, legacyRevision }`; it never writes the v1 file again.
- Because the v1 filename can collide, fallback is accepted only when the decoded v1 `docPath`
  exactly identifies the requested document. Recognized historical forms are provider-specific:
  the raw repository-relative path, or the exact `sourceStorageKey` form
  (`<repository-label>/<raw-path>@<ref>`). No suffix, case-folded, normalized-Unicode, or
  "filename implies owner" match is allowed.
- If `docPath` is absent, malformed, names the other collision candidate, or carries a different
  ref in the storage-key form, quarantine the v1 file and require explicit reconciliation. Never
  display or migrate its threads into the requested document automatically.
- An old tab can still write v1, but cannot corrupt v2 state or remove v2 tombstones. On load,
  if v1 changed after `legacyRevision`, show "legacy client changes need reconciliation" and do
  not auto-merge them. This is an explicit stale-client cutoff, not silent last-writer-wins.
- Reject unknown top-level versions without rewriting them.
- A migrated v1 comment remains `identityVersion`-absent: never synthesize resolved identities
  and never notify merely by load/re-save. Waiting-on remains best-effort from parsed handle and
  `authorLogin ?? author`.
- New comments use `identityVersion: 1`; validate author key sets, mention spans, subject keys,
  provider keys, routes, and dispatch state. Waiting-on compares key-set intersection.
- Render identity-aware mentions from validated spans; use regex only for legacy comments.

### Signed-out and sample authorship

Signed-out comments are useful, but "You" is not an identity authority.

- A signed-out comment is `localOnly: true`, `author: 'You'`, has an empty author key set, and
  every typed mention is unresolved. It can be stored only in the v2 `localStorage` key.
- The decoder rejects `localOnly` comments in a remote sidecar. Remote save filters nothing
  silently; it stops and asks the reviewer what to do.
- Signing in does not auto-attribute or auto-publish local comments. Offer one explicit action:
  **Attribute and publish local comments as <display name>**. Show the count and destination;
  on confirmation, rewrite author/name/key set, re-resolve desired mentions, then CAS-save.
- Declining leaves them local. Signing out never rewrites already attributed remote comments.
- Built-in sample threads remain display-only legacy data; new sample replies are local-only.
- While signed out, disable resolve/reopen, intent changes, re-anchor, source edits, and deletion
  of remotely loaded threads. Those are shared state mutations and have no anonymous identity to
  attribute.
- A reviewer may discard a thread created entirely in the current local-only workspace; that
  removes local data and creates no mutation to publish. Once any remote thread/comment is
  involved, deletion is unavailable until sign-in.
- The explicit attribution dialog covers both local comments and any local-only new threads.
  There is no local journal for mutating pre-existing remote thread state in this MVP.

This closes the current path where an anonymous `You` comment can later enter the autosave flow
after sign-in.

### Legacy data disposition

"No resolver-derived email identity metadata" applies to v2 output and requires disposing of the current ADO snapshot,
not pretending old data never existed.

- Before hosted release, delete `.docthread-reviews/ado/*.json` from the branch and stop loading
  that path. It contains full work-item Markdown and UPN-valued authors.
- Replace `tests/adoSnapshot.test.ts` and the production-derived snapshot with a fully synthetic
  fixture containing no real document text, IDs, names, or addresses.
- V1-to-v2 migration never copies an email-shaped `author`. Resolve it to provider display name
  and keys when possible; otherwise persist a redacted local part as display-only legacy text.

**Decision: purge the history; accepted retention is not an option.** Measured scope on
2026-08-23: the snapshot path is reachable from **55 commits** over 2026-08-20/21, on `main` and
`sample-user-manual`. It contains internal work-item content and real identity data; deleting
only HEAD does not remediate that exposure.

Mandatory release procedure, following GitHub's sensitive-data-removal guidance:

1. Disable the ADO proxy/snapshot writer and freeze repository writes. Merge or close open PRs;
  record the current protected branches, tags, forks, collaborators, and affected PRs.
2. In a fresh restricted mirror, use `git-filter-repo >= 2.47` with
  `--sensitive-data-removal --invert-paths --path .docthread-reviews/ado/`. Do not perform this
  destructive rewrite in the normal working clone.
3. Inspect `changed-refs`, the first changed commits, affected PR refs, signatures, and any LFS
  report. Verify `git rev-list --objects --all` contains neither the directory nor snapshot
  blobs, and run the identity/PII scan across every rewritten ref.
4. Temporarily allow the coordinated force push, mirror-push all affected branches/tags, verify
  `main` and `sample-user-manual`, then restore branch protection immediately.
5. Open a GitHub Support sensitive-data-removal request with repository, affected PR count,
  first changed commits, and any LFS report. Require PR-ref dereferencing, server garbage
  collection, and cached-view removal.
6. Inventory forks and coordinate deletion/cleanup. Every collaborator discards and reclones or
  follows `git-filter-repo` cleanup instructions; nobody merges old history back. Notify the 12
  current repository collaborators and obtain acknowledgements before reopening writes.
7. Delete the temporary mirror after evidence is captured without retaining the sensitive blob.
  Record hashes/counts and Support ticket outcome, not the removed content.

**Release evidence:** clean all-ref scan, rewritten-ref list, restored protections, collaborator
notice, fork disposition, and GitHub Support confirmation. If Support will not remove cached/PR
references, do not release from this repository: create a clean repository from the rewritten
tree, move the hosted deployment there, restrict/archive or delete the old repository, and rerun
all evidence checks. There is no "accept and ship" branch.

### Conflict-safe sidecar writes

The current auto-save is a last-writer-wins full-file write. GitHub rejects stale file SHAs but
has no merge/retry path. Azure Repos is worse: `revision` currently controls only add versus
edit; the client fetches the latest branch tip and can push stale full-file content over another
reviewer's threads. Notification ordering is meaningless until this is fixed.

Add a single per-document save coordinator:

1. Serialize local saves; never have two writes for one sidecar in flight.
2. Load the latest remote file and provider CAS token.
3. Merge by stable IDs, then write against that exact token.
4. On `409` / branch-tip conflict, reload, merge, and retry at most twice with jitter.
5. Return the accepted merged file and revision; R10 verifies the exact comment in that file.

Merge rules:

- Comments are immutable and unioned by `comment.id`. Any same-ID difference in the canonical
  `ImmutableCommentCore` — including mention identities or routes — is corruption and stops the
  save. Dispatch state is merged separately and may advance only monotonically.
- Add per-field clocks, not one `Thread.updatedAt`:

  ```ts
  interface ThreadClocks {
    resolutionAt: string;
    intentAt: string;
    anchorAt: string;
  }
  ```

  Resolve/reopen updates only `resolutionAt`; intent updates only `intentAt`; re-anchor updates
  only `anchorAt`. Merge each field independently by its clock after comments are unioned. Equal
  clock with unequal values is corruption, not a tie-break opportunity.
- Deletion becomes a `deletedAt` tombstone, not array removal, so a concurrent stale writer
  cannot resurrect a deleted thread. **Deletion is terminal regardless of later timestamps**;
  there is no undelete operation in this MVP. A stale reply/resolve/re-anchor against a
  tombstoned thread is rejected and surfaced for manual copy/reconciliation, never merged.
- Notification dispatch state advances monotonically:
  `pending < attempted < delivered|failed|uncertain`; merge never moves it backward.
- Legacy threads use `createdAt` as each initial field clock without rewriting until that field
  is actually mutated. A terminal tombstone wins over every field clock.

Provider CAS details:

- GitHub: Contents API SHA is insufficient because it does not guard branch movement when the
  sidecar blob itself is unchanged. Load the branch head commit and source blob together. Build
  a Git tree containing the merged sidecar (and any source edit), create a commit whose sole
  parent is that exact expected head, then `PATCH git/refs/heads/{branch}` with `force: false`.
  If the branch advanced, the non-fast-forward ref update fails atomically; reload source,
  sidecar, and head, re-anchor/merge, then retry at most twice. Concurrent first creation is the
  same path and needs no special Contents-API error classification.
- Azure Repos: loader returns the **branch-tip commit ID**, not the sidecar blob `objectId`, and
  reads the sidecar pinned to that tip. Push uses that commit as `oldObjectId`.
- ADO work-item shared reviews need the #15 backend before release; that backend must expose the
  same read/merge/CAS contract.

### Review-status automation and installed content repositories

The PR analyzer currently maps Markdown only to the lossy v1 path and is copied verbatim into
every integrated GitHub/Azure Repos content repository. V2 must update that distributed surface.

- `.github/scripts/docthread-review.mjs` computes the collision-safe v2 path first, then checks
  v1 only as a read-only fallback. It recognizes changed files under both `.docthread/v2/**`
  and legacy `.docthread/**`.
- When both exist, v2 is authoritative. A changed v1 whose recorded revision no longer matches
  v2 reports the explicit legacy-reconciliation warning, not "missing sidecar".
- `.github/scripts/docthread-review.test.mjs` shares canonical vectors with the app tests,
  including `a/b.md` versus `a__b.md`, spaces, Unicode NFC, and rejected dot segments.
- `scripts/install-content-repo.ps1` distributes the updated analyzer to both provider layouts;
  its PowerShell integration test verifies the installed copy finds v2 and still reads v1.
- Existing content repositories need the installer rerun (or an equivalent analyzer PR) before
  the first v2 sidecar lands there. Treat that rollout ordering as a deployment prerequisite.

> **Regression trap — must be in the same change.**
> `deriveWaitingOn` and `isWaitingOnViewer` currently compare
> `normalizeIdentity(comment.author)` against extracted mentions. The moment `author` becomes
> `"Maya Stewart"` that comparison stops matching and the waiting-on badges silently go blank.
> New comments compare stable-key sets; only legacy comments use `authorLogin ?? author`.

### Bug found while designing this — reproduced, not theorised

`MENTION_RE` has no left word boundary. Run against the current source:

```
extractMentions("ping maya@contoso.example about this")  ->  ["contoso"]
```

On an ADO document that reaches `loginToEmail('contoso', undefined, 'contoso.example')`,
which takes the bare-alias branch and returns `contoso@contoso.example`. Writing an ordinary
email address in a comment is enough to send document text to a fabricated address.

R1 neutralises the payload — parsed text creates no provider-asserted route, so nothing is sent —
but the regex should still be fixed. `activeMentionQuery` already scans backwards for a
whitespace boundary; `extractMentions` should apply the same test rather than introducing a
lookbehind.

---

## 5. Per-issue design

### #12 — sign-in prompt instead of a parser error

Three layers, in order:

1. **Don't fire a doomed request.** The new source capability matrix knows whether direct ADO,
  ADO proxy, or neither is available. With neither, short-circuit before fetch with
  *"Azure DevOps access isn't configured on this deployment"* — a message that correctly does
  **not** imply the reviewer can fix it. Graph directory sign-in is a separate capability.
2. **Classify before parsing.** Never call `.json()` without checking `content-type`.
  `response.ok` is not sufficient. Measured against work item 1173530 from the deployed SWA
  origin: Azure DevOps redirects to `_signin`, then returns **203 Non-Authoritative
  Information**, `text/html`, and a 15,820-byte sign-in document. `response.ok` is true.
  Content-type is the reliable discriminator; it also catches an SWA fallback serving
  `index.html` for an unrouted `/ado-api/*`.
3. **Return a typed error, not a string.**

```ts
type ProviderErrorKind = 'signin-required' | 'not-configured' | 'forbidden' | 'transport';
```

| Observation | Kind | What the reviewer sees |
|---|---|---|
| Build mode is `static` | `not-configured` | "Microsoft sign-in isn't configured on this deployment" |
| non-JSON body, 2xx/3xx | `signin-required` | "Sign in to Microsoft to load work items" + inline sign-in |
| 401, or 403 with no token sent | `signin-required` | as above |
| `interaction_required` + a `claims` challenge | `signin-required` | "Your organisation needs you to sign in again" — then retry *with* the claims (§3) |
| 403 with a valid token | `forbidden` | "Your account can't read this work item" |
| everything else | `transport` | status + retry |

Apply the same guard on the GitHub path. It behaves correctly today — #14 §1 rightly notes the
org-restriction message is genuinely helpful and passed through intact — but the failure class
is identical and the guard is cheap.

**#12 does not block on #14.** Its previously open status-code question is now closed by the
live measurement above. The hosted build is unconfigured today, and that branch must say so
before any request is attempted.

### #13 — device flow

Current order in `App.tsx`: `await startDeviceLogin()` → `navigator.clipboard.writeText` →
`window.open`. Both side effects happen **after** an await, i.e. outside the user-gesture
window. So today the copy can be silently refused *and* the popup can be silently blocked, and
the reviewer is left staring at an eight-box code field with no code. Two failure modes, one
cause.

Removing the automatic `window.open` removes both, because the copy moves onto an explicit
button press — a real gesture, in a secure context.

```
Your sign-in code
    302E-80F3            [ Copy ]          Copied ✔
    Expires in 14:32                       [ Get a new code ]

    [ Open GitHub to enter it ]

    Waiting for you to authorise on GitHub…
```

- The code stays on screen behind the new tab, so it survives a failed paste
- The copy is acknowledged, not silent
- The button names what the next page will ask for
- `expiresIn` is already returned by `startDeviceLogin` and currently unused — spend it on the
  countdown and the re-request
- Poll state text runs while `pollForDeviceToken` is in its `setTimeout` loop, so the app never
  looks frozen

### #14 — split it

#14 is three different things in one issue: a config note (§2, §3), a status/docs note (§1),
and an **open security vulnerability** (§4). The vulnerability will get lost in there.

Proposal:
- **§4 → its own security issue**, carrying R1 + R2, and it is the one that gates release
- **§2, §3 → `docs/deployment.md`** — Entra SPA registration, redirect URI, the two repo
  variables, and the build-time `AUTH_MODE` resolution, including the trap that setting a
  variable changes nothing until a rebuild
- **§1 stays on #14** as the live tracker for org approval

The §3 trap is worth keeping verbatim wherever it lands: GitHub returns an identical `404` from
`/login/device/code` for both a disabled device flow and an unknown `client_id`, so a
mistranscribed ID is indistinguishable from a misconfigured app. It cost about an hour.

---

## 6. Scope

**In — ships as one MVP**

1. `src/identity.ts`: provider-stable identity model, GitHub/Graph resolvers, ADO confirmer,
  ranking, session cache
2. **Independent capabilities** for Graph directory, direct ADO, ADO proxy, and GitHub; setting
  the Graph client ID must not silently enable direct ADO
3. **One shared people picker** in new-thread and reply composers, accepting multi-word name,
  alias, or email input
4. **Schema-v2 sidecar at a new path** with validated `MentionReference[]` spans,
  `Comment.authorIdentityKeys`, and read-only v1 migration
5. GitHub collaborator search through repository GraphQL; exact-email Graph join only when a
  public GitHub profile email exists
6. Entra search through Graph `User.ReadBasic.All`, with explicit guest/duplicate treatment
7. Work-item `CreatedBy` / `AssignedTo` seeds and exact ADO identity confirmation for native
  work-item mentions when delegated ADO write access exists
8. Friendly names everywhere a raw login is shown today
9. #12 typed response classification and #13 explicit device-flow UX
10. #14 §4: delete every address-derivation path and disable/remove the anonymous custom email
   relay; persist before native notification
11. Disable the current ADO proxy/shared snapshot fallback; keep hosted ADO work items behind a
  capability flag until #15 supplies per-item authorization and secure storage

**Out — deliberately**

| Deferred | Why |
|---|---|
| Microsoft Graph enrichment beyond `User.ReadBasic.All` | The basic profile is exactly the picker's field set. `User.Read.All` *does* require admin consent and buys nothing we need |
| ADO Identity Picker | Superseded by Graph, which asks for less consent. Kept as a later refinement only if "who has ADO access" filtering is wanted |
| Cross-provider linking beyond provider `originId` or exact asserted mail | Any looser heuristic reintroduces the #14 §4 bug class |
| **Group and team mentions** | Graph queries `/users`, not groups. Group notification is an unbounded fan-out and needs its own risk decision |
| Custom direct email | The current relay is anonymous. Reintroduction requires the authenticated API design in R9 |
| Native ADO mention through the shared PAT proxy | Permanently disallowed; #15 must use caller-scoped per-item authorization |
| Avatars in the *gutter* | Cosmetic there. In the *picker* they are in scope — two people named Maya Stewart is a real tenant occurrence, and the avatar plus secondary line is how the reviewer tells them apart |
| #15 implementation details | Separate work item, but **release gate** for hosted ADO review |

### Change surface

| File | Change |
|---|---|
| `src/identity.ts` | **New.** Identity types, Graph resolver, GitHub GraphQL resolver, ADO confirmation, ranking, cache |
| `src/reviewSchema.ts` | **New.** Central untrusted-JSON decoder and identity-extension validation |
| `src/reviewPersistence.ts` | **New.** Per-document save queue, merge rules, CAS retry, dispatch claim |
| `src/components/MentionComposer.tsx` | **New.** Shared accessible stateful picker for new comments and replies |
| `src/mentions.ts` | Stateful mention session; combined ranking; legacy-only handle normalization |
| `src/review.ts` | Boundary-safe legacy parser; stable-key waiting-on with v1 fallback |
| `src/types.ts` | Schema-v2 sidecar, `identityVersion: 1` comments, mention/author key sets, dispatch, migration metadata |
| `src/github.ts` | GitHub collaborator GraphQL + minimal native notification; delete all direct-email code |
| `src/ado.ts` | Add `System.TeamProject`, `CreatedBy`, `AssignedTo`; parse identities; add delegated native-comment method |
| `src/azureRepos.ts` | Return branch-tip CAS token, read pinned revision, merge/retry instead of stale full-file overwrite |
| `src/azureAuth.ts` | Separate Graph and ADO token methods; auth capability split; CA interaction/claims handling; local MSAL override |
| `src/auth.ts` | Request `repo read:org`; stable GitHub node ID; remove `NOTIFY_ENDPOINT`; clear cache on sign-out |
| `src/providers.ts` | Source-specific capabilities; never infer ADO permission from Graph configuration |
| `src/source.ts` | Provisional versus canonical targets; explicit GitHub ref type/resolver; versioned target deep links; raw-code-point v2 path encoding |
| `src/App.tsx` | Shared picker orchestration; persist-first notification; typed errors; #13 flow; stable author identity |
| `src/components/CommentGutter.tsx` | Use shared picker for replies; render validated extended spans rather than regex |
| `api/ado-api`, ADO snapshot fallback | Disable for hosted MVP; #15 replaces, not extends, this trust model |
| `api/gh-api`, `VITE_GH_API_BASE`, `GH_SERVER_TOKEN` | Delete; direct visitor OAuth only |
| `api/notify`, Vite notify handler, Worker `/notify` | Disable/remove from the secure MVP |
| `vite.config.ts` | Remove notify middleware; make Graph/ADO transports explicit, not implicit `DEV` branches |
| `infra/logicapp.json` | Remove from secure-MVP deployable infrastructure |
| `.env.example`, SWA/Azure templates, `scripts/deploy-swa.ps1`, README/deployment/regression docs | Graph client/tenant, explicit transports, `repo read:org`; remove ADO proxy and relay/domain guess |
| `.github/workflows/deploy-pages.yml` | Retire from secure-MVP release path; no shared-variable deployment to an unregistered origin |
| review analyzer + installer | Resolve v2 path first, v1 fallback, collision vectors, distribute before v2 sidecars |
| `package.json`, tests | Discover new unit tests; add Playwright; add opt-in credentialed smoke suite |

**Delete `loginToEmail` entirely — not just its pattern branch.** The function has *two* ways to
produce an address, and the obvious one is not the only one:

```ts
const key = login.toLowerCase();
if (overrides && overrides[key]) return overrides[key];   // <- arbitrary address, no checks
const m = key.match(/^([a-z\d.-]+)_([a-z\d-]+)$/);        // <- the branch #14 §4 describes
```

`overrides` returns whatever it is handed, before any validation. Removing only the regex would
leave a configured map able to point any login at any address — R1 violated, with the fix
appearing complete. Nothing passes `overrides` today, which is exactly why it would survive a
careless cleanup unnoticed.

Remove together, across four files:

| Where | What |
|---|---|
| `src/github.ts` | `loginToEmail`, direct-email types/functions, `overrides`, `defaultDomain` |
| `src/App.tsx` | `ADO_EMAIL_DOMAIN` constant and the `defaultDomain:` argument |
| `.env.example` | the `VITE_ADO_EMAIL_DOMAIN` line |
| `docs/deployment.md` | any reference to it |

`VITE_ADO_EMAIL_DOMAIN` exists only to feed the guess. Once addresses come from the directory it
is dead config, and leaving it documented implies a fallback that must not exist.

Worth noting how little of this is new integration. `getAuthStatus` already fetches `name` and
`avatar_url` from `GET /user`; `getAzureAuthStatus` already reads `account.name` from MSAL;
`App.tsx` already stores both on `ghUser` and `azureUser`. Every one of those is then thrown
away by a single expression:

```ts
const commentAuthor = usingAdoWorkItem ? … : ghUser?.login ?? (authChecked ? 'You' : '');
```

Friendly names for the signed-in reviewer are a small plumbing change. The directory picker,
GitHub GraphQL resolver, validated identity extension, conflict-safe persistence, and
auth-capability split are the substantive work.

---

## 7. Sequencing

```
disable anonymous email relay + hosted ADO proxy      ← immediate live mitigation
  │
purge ADO snapshots from all Git/GitHub references    ← hosted release gate
  │
central decoder + identity extension + identity.ts
        │
  ├──► structured MentionReference[] + stable author keys
        │         │
  │         └──► #14 §4  (R1/R2/R9/R10)           ← release gate
        │
  ├──► Graph/ADO capability split + #12
        │
  ├──► shared picker + friendly names
        │
  ├──► GitHub resolver                  ← needs `repo read:org` + reauth
        │
  ├──► Entra resolver                   ← registration + least-privilege PKCE proven
        │
  ├──► native provider notifications    ← only after durable save
  │
  ├──► #15 secure review backend        ← release gate for hosted ADO work items
  │
  └──► #13                              ← independent
```

The Graph registration is done. Direct ADO remains a separate permission/capability; it gates
Azure Repos, direct work-item loading, and native ADO notification, but not directory search.
#13 can still land independently. Do not deploy the client ID into the current mode logic before
the capability split, or Graph configuration will accidentally select the ungranted ADO path.

---

## 8. Acceptance

Beyond the criteria already written on each issue:

**Identity correctness**
- Entra: typing a display name, alias, or email returns the same Graph identity
- GitHub: name and login use the repository collaborator connection; email uses Graph plus an
  exact public-email join and fails closed when that join is unavailable
- No pattern-derived email address is ever produced, from any input, on any provider
- A typed address the directory does not recognize resolves to nothing and notifies nobody (R7)
- The picker finds a colleague who has never opened this ADO organisation
- Both `azure-repos` and `ado-workitem` select Entra identities; neither falls into GitHub style
- Same-provider equality uses stable IDs; cross-provider joins require exact normalized mail
- Duplicate display names and guest/admin-alt identities require explicit human selection

**Safety**
- The custom email endpoint and Worker route are absent/disabled; the live
  `NOTIFY_WEBHOOK_URL` setting is removed
- A comment containing a literal email address notifies nobody
- Only a validated, resolved span can trigger a native provider notification
- A changed or deleted selected token loses its resolved identity before save
- No resolver-derived email metadata, Graph token, or ADO token appears in a v2 sidecar,
  DocThread log, deep link, error message, or telemetry. User-authored prose and provider request
  URLs are the documented exceptions. Current ADO snapshots are removed from HEAD and history
  purge evidence is complete
- Native notification happens only after the sidecar save succeeds
- A timeout produces "delivery uncertain" and no automatic retry
- **No account is auto-selected.** A `#EXT#` UPN is visibly marked "Possible guest" before the
  comment is saved; unmarked results are not claimed to be internal
- Provider notification contains only the mention and review link, never quote/comment content

**Compatibility**
- V1 loads read-only; the first write creates a separate v2 sidecar and never rewrites v1
- A stale v1 tab cannot alter v2 tombstones/dispatch; a changed legacy revision produces an
  explicit reconciliation warning rather than automatic merge
- New v2 comments carry `identityVersion: 1`; migrated comments remain legacy/unresolved
- Waiting-on remains best-effort for legacy comments and uses stable-key sets for extended ones
- A sidecar written by a signed-in reviewer displays the right names to a reader with no ADO
  access and no network
- The gutter shows a real name for any participant the provider could identify, and the raw
  handle — never a blank — for any it could not
- Graph-only configuration never enables direct ADO calls; unavailable capabilities are shown
  as unavailable rather than attempted
- A caller with GitHub review-repository access but no work-item access receives neither the
  live work item, stored snapshot, threads, nor a proxy response containing them
- No generic server-token GitHub or ADO proxy route is present in the hosted artifact; private
  provider access always uses the visitor's delegated token or the future #15 backend
- Two concurrent reviewers adding comments produce their union; resolution, intent, and anchor
  merge by independent clocks; terminal deletion wins; no accepted comment/state is silently
  overwritten
- `a/b.md` and `a__b.md` have distinct v2 paths; persisted provider/path must equal the
  requested source before rendering, while repository/ref remain authenticated runtime context
- NFC and NFD filenames remain distinct and round-trip exactly; no Unicode normalization in the
  storage encoder
- Azure Repos default branch and ADO `System.TeamProject` are resolved before any v2 key exists
- GitHub slash refs, branch/tag ambiguity, and ref/path boundaries are API-resolved; generated
  DocThread links carry canonical target JSON and never rely on blob-URL splitting
- GitHub tag/commit targets are read-only/local-only; only a resolved branch can write a shared
  sidecar or source file
- Review-status automation finds v2 first and v1 as fallback in installed GitHub and Azure Repos
  integrations
- Signed-out comments remain local until the reviewer explicitly attributes and publishes them;
  no remote sidecar accepts `localOnly`
- Signed-out reviewers cannot resolve/reopen/delete/re-anchor or edit other shared thread state;
  discarding a wholly local-only thread is the sole local deletion exception

**Feel**
- Results appear on the first keystroke from the prefetched seed set, before any network call
- Full names and email addresses remain searchable after spaces, dots, and the second `@`
- New comments and replies have the same picker and keyboard behavior
- "No match" is visibly distinct from "still searching"
- Typing quickly does not produce out-of-order results — the stale request must be aborted
- A directory outage degrades to the seed set with a stated reason, never to an empty list
- The picker still works signed-out and on the built-in sample, exactly as it does today

**Deployment**
- `VITE_AZURE_CLIENT_ID=3a9dd418-f26a-4e43-b3bb-30a5c89b251a` and tenant
  `72f988bf-86f1-41af-91ab-2d7cd011db47` enable Graph only
- GitHub device flow requests `repo read:org`; a token missing `read:org` gets an actionable
  reauthorization prompt
- Direct ADO is opt-in and remains disabled until its separate delegated permission is granted
- The registration requests only `User.ReadBasic.All`; `openid profile` are runtime OIDC scopes
- No notification secret is present while the custom relay is disabled
- Workflow, Azure Pipelines template, and `deploy-swa.ps1` produce the same capability matrix,
  GitHub scope, client ID, tenant, and disabled ADO state
- GitHub Pages has no active release trigger and is not documented as a supported secure-MVP host
- Git history purge evidence, GitHub Support cache/PR cleanup, collaborator acknowledgements,
  and fork disposition are complete before hosted release

## 9. Test plan

- Unit: provider key construction; same-provider equality; exact-mail cross-provider join;
  null/mismatched mail never joins
- Unit: live-shaped Graph, GitHub GraphQL, ADO `IdentityRef`, and ADO Identities API fixtures
- Unit: ranking — exact alias/email, participant priority, members before `#EXT#`; stable ties;
  never auto-select
- Unit: stateful mention session accepts `Maya Stewart` and `mayast@contoso.example`, opens after
  punctuation, and closes on Escape/newline/caret escape
- Unit: span reconciliation drops identity when selected text is edited; body text alone never
  creates a resolved mention
- Unit: v1/v2 decode, unknown top-level/comment identity version, v1-to-v2 sanitization,
  stable-key waiting-on, and changed-legacy-revision warning
- Unit: canonical document identity and v2 path vectors — collision pair, spaces, Unicode NFC,
  distinct NFC/NFD paths, provider/ref differences, rejected dot/backslash segments, and
  persisted-identity mismatch
- Unit: the same v2 remote sidecar remains valid after branch merge and fork-to-upstream merge,
  while localStorage identities remain distinct by repository/ref
- Unit: same-named GitHub branch and tag produce distinct canonical/localStorage keys and retain
  branch-writable versus tag-read-only capability
- Unit: provisional-source resolution — Azure Repos null ref resolves default branch; ADO missing
  project resolves `System.TeamProject`; failure creates no v2 storage key
- Unit: GitHub target resolver — ordinary and `%2F` slash refs, exact-once decoding, branch/tag
  same-name ambiguity, competing ref/path boundaries, 40-hex commit, invalid short SHA, encoded
  slash in path, over-limit tail, disappeared ref, and no implicit default fallback
- Unit: generated target deep-link round-trip/size validation; untrusted base64url payload cannot
  bypass provider/path/ref verification
- Unit: GitHub branch target writable; tag/commit targets local-only/read-only
- Unit: `localOnly` comments cannot enter remote persistence; explicit attribution rewrites author
  display/key set and requires mention re-resolution
- Unit: signed-out shared mutations are disabled; wholly local-only thread discard remains local
- Unit: auth capability matrix — Graph-only client configuration cannot call ADO
- Unit: #12 classification including the measured 203 + HTML response
- Unit: debounce, abort, 429/`Retry-After`, positive/negative cache, cache clear on sign-out
- Unit: cache key isolation across account, tenant, repository/organization, resolver, and
  transport; late request generation is discarded even when abort loses the race
- Unit: merge/CAS — concurrent comment union, same-ID corruption, independent thread field clocks,
  deletion tombstones, monotonic dispatch state, bounded conflict retry, and concurrent first
  creation of an absent GitHub sidecar
- **Unit: R8 duplicate handling** — commit only the sanitized three-object shape from §3 with
  fictitious names, IDs, and reserved-domain addresses; assert member before guest, `mail`
  retained separately from UPN, and no auto-selection
- Contract: GitHub collaborator GraphQL query handles name/login and an insufficient-scope error
- Contract: GitHub dispatch resolves node ID to current login, revalidates the exact node as a
  collaborator plus Issues/write capability, and never trusts persisted login text
- Contract: Graph email-to-GitHub join hydrates only candidate profiles and requires exact mail
- Contract: ADO confirmation requires active user + exact Graph object ID and emits documented
  `@<{adoIdentityId}>` syntax
- Security contract: the current ADO proxy and snapshot fallback are unreachable in hosted
  builds; #15 tests deny a caller who has review-repo access but lacks the specific work-item
  permission
- Contract: save failure causes zero notification calls; save success causes one
- Contract: changing author keys, mention subject/provider keys, spans, or route under an
  existing comment ID is corruption and causes zero provider calls
- Contract: `pending → attempted` CAS is required before provider call; `attempted`/`uncertain`
  is never automatically retried
- Contract: no `/api/notify`, Vite notify handler, or Worker `/notify` route remains reachable
- Security contract: no `/api/gh-api`, `GH_SERVER_TOKEN`, or `VITE_GH_API_BASE` fallback remains
- Release check: all-ref object scan contains no `.docthread-reviews/ado/` path/blob; rewritten
  refs and Support cleanup evidence are present without retaining removed content
- **Guard: a repo-wide assertion that `loginToEmail`, `overrides` and `defaultDomain` are gone.**
  A grep-style test is crude but this is a deleted-code invariant, and the failure mode is
  silent reintroduction
- Regression: legacy sidecar round-trip (`docs/REGRESSION-CHECKLIST.md`)
- Regression: updated review analyzer and installed GitHub/Azure Repos copies resolve v2 first,
  v1 fallback, and legacy-revision divergence
- Regression: analyzer emits versioned canonical commit target rather than a nested GitHub blob
  URL; slash-containing branch links round-trip through the app resolver
- Regression: workflow, template, and PowerShell deploy surfaces agree on `repo read:org`, Graph
  transport, tenant, and ADO-off state
- Regression: Pages workflow has no active deployment trigger and no docs claim it is supported
- Browser: desktop/mobile picker placement, non-overlap, keyboard/assistive semantics, Graph and
  GitHub CORS, device-code flow, CA interaction fallback
- Mutation proofs on notification-from-body, stable-key waiting-on, persist-before-notify, and
  guest ranking; delete code rather than comment it out, and verify the fixed test first

### Harness changes

The current `npm test` names a fixed list of files and has no browser runner. Update it as part
of implementation; otherwise adding tests can create a false green because CI never discovers
them.

- Put provider decoders, ranking, capability derivation, merge, and dispatch transitions in pure
  modules covered by ordinary Node tests with captured fixtures.
- Add a cross-platform `scripts/run-tests.mjs` that enumerates `tests/**/*.test.{ts,mjs}` and
  invokes `node --test --experimental-strip-types` with concrete paths. It must also preserve
  `.github/scripts/docthread-review.test.mjs` and invoke
  `tests/install-content-repo.test.ps1`; test discovery must not silently drop either suite.
- Add Playwright for a built production bundle with mocked providers: desktop/mobile layout,
  keyboard/ARIA behavior, redirect restoration, scope-error UX, and non-overlap screenshots.
- Add an opt-in credentialed smoke suite, excluded from normal PR CI, for real Graph `$search`,
  GitHub GraphQL CORS, ADO identity lookup, ADO comments-route CORS, and CA behavior. Use a
  designated test work item for any write; the default smoke remains read-only.
- Add build-artifact inspection proving no notify Function, Worker `/notify`, current
  `api/ado-api`, **or generic `api/gh-api` Function** was packaged.
- Add a user-copy guard: `src/sample.ts`, README, and deployment docs must not promise email or
  hosted ADO behavior that the secure MVP deliberately disables.

## 10. Decisions taken

**D1 — An unresolvable mention saves, with a warning.**
`@bob` that resolves to no provider identity still renders, still sets waiting-on, still shows
in the gutter; the composer says *"@bob — unresolved, not notified."* Blocking the save would
fail closed against the reviewer rather than against the attacker, and would make an identity
service outage look like a broken comment box. R4 restated.

**D2 — Custom direct email is disabled for MVP.**
The live anonymous relay is not made acceptable by adding one string check. Native provider
notifications cover GitHub and delegated ADO work items; other assignments persist with an
explicit "not notified" state. R9 defines the bar for reintroduction.

**D3 — Issue hygiene is recommended, not applied.**
The #14 split in §5 is a recommendation only. Splitting issues and posting comments are writes
to a shared repository and have been left for a human to action.

**D4 — Free-typed text stays mentionable; free-typed addresses do not become destinations.**
The picker is not modal and does not force selection (D1). A reviewer may type `@bob` and move
on. What they cannot do is cause mail to reach an address the directory never confirmed — that
is R7, and it is what separates this feature from a nicer-looking version of the #14 §4 bug.

**D5 — Users only, no groups, for MVP.**
Graph queries `/users` only. Group mention is an unbounded fan-out and needs its own risk review.

**D6 — Provider-native notifications are the default.**
GitHub issue mention for GitHub; ADO work-item mention for a confirmed ADO identity and delegated
write token; no notification otherwise. Never silently substitute custom email.

**D7 — Schema v2 lives at a new path.**
This isolates tombstones, CAS state, and dispatch claims from stale v1 writers. V1 is read-only;
new comments inside v2 carry `identityVersion: 1`; one central decoder validates both formats.

## 11. Verified facts and remaining gates

**Verified against live systems on 2026-08-23**

- ADO signed-out response is 203 + `text/html` after redirect to `_signin`.
- Graph query resolves alias/name/email under the broad CLI token; the DocThread SPA's
  least-privilege PKCE token independently resolved `rosacek` with `User.ReadBasic.All` alone.
- GitHub global user search returns zero for these EMU users, including exact login.
- GitHub repository GraphQL collaborator filtering resolves name and alias, returns friendly
  names/stable IDs, supports SWA-origin CORS, and exposes rate-limit headers.
- All 12 current DocThread collaborators expose public email through exact profile lookup;
  email remains an optional exact-join field, not a universal assumption.
- Real work-item identity fields are `IdentityRef` objects; exact ADO lookup maps UPN to active
  ADO ID and Graph object ID. The organization-only comments route is 404; `System.TeamProject`
  supplies the required project route.
- Official ADO docs specify API mention syntax `@<{userID}>` and say it sends notification.
- The live SWA has only `NOTIFY_WEBHOOK_URL`; the endpoint is anonymous and forwards arbitrary
  client HTML/recipients. Remove that setting as the immediate mitigation.

**Remaining release gates — none blocks starting the safe implementation**

1. GitHub org approval plus a fresh device token with `repo read:org` gates hosted collaborator
  search. Missing scope degrades to local participants; it does not block commenting.
2. Direct ADO permission is not on the Graph-only registration. It gates Azure Repos, direct
  work-item access, and native ADO notification — not people search or schema work. The Azure
  DevOps resource declares `user_impersonation` as user-consentable, but this tenant has not
  classified it `low`; treat its consent outcome as unverified until separately probed.
3. The mandatory Git/GitHub history purge above gates any hosted release. It is an operational
  security procedure, deliberately not performed as part of design work.
