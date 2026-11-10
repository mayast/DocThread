import assert from 'node:assert/strict';
import test from 'node:test';

import {
  durableIdentityHandle,
  graphUsersSearchUrl,
  identityDisplayName,
  joinGraphMailToGitHubCollaborators,
  makeSearchCandidate,
  rankIdentityCandidates,
  searchGitHubCollaborators,
  searchGraphUsers,
  verifyGitHubNotificationRecipients,
  type IdentitySubject,
} from '../src/identity.ts';

function subject(key: string, displayName: string, handle: string): IdentitySubject {
  return {
    subjectKey: key,
    linkedKeys: [key],
    displayName,
    identities: [{ key, authority: key.startsWith('github:') ? 'github' : 'entra', displayName, handle }],
  };
}

test('Graph search uses the documented advanced-query contract', () => {
  const value = graphUsersSearchUrl('maya "quoted"');
  assert.ok(value);
  const url = new URL(value);
  assert.equal(url.searchParams.get('$count'), 'true');
  assert.equal(url.searchParams.get('$top'), '10');
  assert.equal(
    url.searchParams.get('$select'),
    'id,displayName,givenName,surname,mail,userPrincipalName'
  );
  assert.match(url.searchParams.get('$search') || '', /displayName:maya \\"quoted\\"/);
});

test('email-shaped account fallback persists only its local alias as display text', () => {
  assert.equal(identityDisplayName(undefined, 'mayast@contoso.example'), 'mayast');
  assert.equal(identityDisplayName('Maya Stewart', 'mayast@contoso.example'), 'Maya Stewart');
  assert.equal(durableIdentityHandle('mayast@contoso.example'), 'mayast');
  assert.equal(durableIdentityHandle('mayast_microsoft'), 'mayast_microsoft');
});

test('Graph results use stable keys and do not serialize mail evidence', async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const candidates = await searchGraphUsers(
    async (url, init) => {
      request = { url: String(url), init: init || {} };
      return Response.json({
        '@odata.count': 1,
        value: [
          {
            id: 'object-1',
            displayName: 'Maya Stewart',
            mail: 'Maya.Stewart@contoso.example',
            userPrincipalName: 'mayast@contoso.example',
          },
        ],
      });
    },
    'graph-token',
    'tenant-1',
    'mayast'
  );

  assert.ok(request);
  assert.equal(new Headers(request.init.headers).get('ConsistencyLevel'), 'eventual');
  assert.equal(candidates[0].subject.subjectKey, 'entra:tenant-1:object-1');
  assert.equal(candidates[0].handle, 'mayast');
  assert.equal(candidates[0].secondaryLabel(), 'maya.stewart@contoso.example');
  assert.doesNotMatch(JSON.stringify(candidates[0]), /contoso\.example/i);
});

test('mail equality requires provider-asserted mail on both candidates', () => {
  const left = makeSearchCandidate(
    subject('entra:t:1', 'Maya Stewart', 'mayast'),
    'entra',
    'mayast',
    { mail: 'Maya.Stewart@contoso.example', assertedBy: 'entra' }
  );
  const right = makeSearchCandidate(
    subject('github:1', 'Maya Stewart', 'mayast_contoso'),
    'github',
    'mayast_contoso',
    { mail: 'maya.stewart@CONTOSO.EXAMPLE', assertedBy: 'github' }
  );
  const missing = makeSearchCandidate(
    subject('github:2', 'Maya Stewart', 'mayast'),
    'github',
    'mayast'
  );
  const upnOnly = makeSearchCandidate(
    subject('github:3', 'Maya Stewart', 'mayast'),
    'github',
    'mayast',
    { userPrincipalName: 'maya.stewart@contoso.example', assertedBy: 'github' }
  );
  assert.equal(left.assertedMailEquals(right), true);
  assert.equal(left.assertedMailEquals(missing), false);
  assert.equal(left.assertedMailEquals(upnOnly), false);
});

test('GitHub collaborator search requests repository-scoped GraphQL and maps node IDs', async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const candidates = await searchGitHubCollaborators(
    async (url, init) => {
      request = { url: String(url), init: init || {} };
      return Response.json({
        data: {
          repository: {
            collaborators: {
              nodes: [{ id: 'U_example', login: 'mayast_contoso', name: 'Maya Stewart' }],
            },
          },
        },
      });
    },
    'https://api.github.com',
    'github-token',
    { owner: 'contoso', repo: 'docs' },
    'maya'
  );

  assert.ok(request);
  assert.equal(request.url, 'https://api.github.com/graphql');
  const body = JSON.parse(String(request.init.body));
  assert.deepEqual(body.variables, { owner: 'contoso', repo: 'docs', term: 'maya' });
  assert.equal(candidates[0].subject.subjectKey, 'github:U_example');
  assert.equal(candidates[0].subject.displayName, 'Maya Stewart');
});

test('GitHub notification preflight resolves current logins and confirms collaborator IDs', async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (body.query.includes('DocThreadNotificationPreflight')) {
      return Response.json({
        data: {
          viewer: { id: 'U_reviewer', login: 'reviewer' },
          nodes: [{ id: 'U_maya', login: 'mayast_microsoft' }],
          repository: { hasIssuesEnabled: true, viewerPermission: 'MAINTAIN' },
        },
      });
    }
    return Response.json({
      data: {
        repository: {
          collaborators: {
            nodes: [{ id: 'U_maya', login: 'mayast_microsoft', name: 'Maya Stewart' }],
          },
        },
      },
    });
  };

  assert.deepEqual(
    await verifyGitHubNotificationRecipients(
      fetchImpl,
      'https://api.github.com',
      'token',
      { owner: 'contoso', repo: 'docs' },
      [{ nodeId: 'U_maya' }],
      'U_reviewer'
    ),
    ['mayast_microsoft']
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].variables.ids, ['U_maya']);
  assert.equal(requests[1].variables.term, 'mayast_microsoft');
});

test('GitHub notification preflight rejects missing issue permission', async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      data: {
        viewer: { id: 'U_reviewer', login: 'reviewer' },
        nodes: [{ id: 'U_maya', login: 'mayast_microsoft' }],
        repository: { hasIssuesEnabled: true, viewerPermission: 'READ' },
      },
    });
  await assert.rejects(
    verifyGitHubNotificationRecipients(
      fetchImpl,
      'https://api.github.com',
      'token',
      { owner: 'contoso', repo: 'docs' },
      [{ nodeId: 'U_maya' }],
      'U_reviewer'
    ),
    /cannot create issue notifications/
  );
});

test('GitHub notification preflight rejects an account switch from the persisted author', async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      data: {
        viewer: { id: 'U_other', login: 'other' },
        nodes: [{ id: 'U_maya', login: 'mayast_microsoft' }],
        repository: { hasIssuesEnabled: true, viewerPermission: 'MAINTAIN' },
      },
    });
  await assert.rejects(
    verifyGitHubNotificationRecipients(
      fetchImpl,
      'https://api.github.com',
      'token',
      { owner: 'contoso', repo: 'docs' },
      [{ nodeId: 'U_maya' }],
      'U_reviewer'
    ),
    /no longer matches the persisted comment author/
  );
});

test('email input joins Graph and GitHub only on exact provider-asserted public mail', async () => {
  const graph = makeSearchCandidate(
    subject('entra:tenant:maya', 'Maya Stewart', 'mayast'),
    'entra',
    'mayast',
    { mail: 'maya.stewart@contoso.example', assertedBy: 'entra' }
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/users/mayast_contoso')) {
      return Response.json({
        node_id: 'U_maya',
        login: 'mayast_contoso',
        name: 'Maya Stewart',
        email: 'MAYA.STEWART@contoso.example',
        avatar_url: 'https://avatars.example/maya',
      });
    }
    const body = JSON.parse(String(init?.body));
    return Response.json({
      data: {
        repository: {
          collaborators: {
            nodes: [{ id: 'U_maya', login: 'mayast_contoso', name: 'Maya Stewart' }],
          },
        },
      },
      query: body.query,
    });
  };
  const joined = await joinGraphMailToGitHubCollaborators(
    fetchImpl,
    'https://api.github.com',
    'token',
    { owner: 'contoso', repo: 'docs' },
    [graph]
  );
  assert.equal(joined.length, 1);
  assert.equal(joined[0].subject.subjectKey, 'github:U_maya');
  assert.deepEqual(joined[0].subject.linkedKeys, ['entra:tenant:maya', 'github:U_maya']);
  assert.doesNotMatch(JSON.stringify(joined[0]), /contoso\.example/i);
});

test('exact GitHub email join preserves the possible-guest safety hint', async () => {
  const graph = makeSearchCandidate(
    subject('entra:tenant:guest', 'Maya Guest', 'maya_guest'),
    'entra',
    'maya_guest',
    {
      mail: 'maya.guest@example.net',
      userPrincipalName: 'maya_example.net#EXT#@contoso.onmicrosoft.com',
      assertedBy: 'entra',
    }
  );
  const fetchImpl: typeof fetch = async (input) =>
    String(input).includes('/users/')
      ? Response.json({
          node_id: 'U_guest',
          login: 'maya_guest_contoso',
          name: 'Maya Guest',
          email: 'maya.guest@example.net',
        })
      : Response.json({
          data: {
            repository: {
              collaborators: {
                nodes: [{ id: 'U_guest', login: 'maya_guest_contoso', name: 'Maya Guest' }],
              },
            },
          },
        });
  const [joined] = await joinGraphMailToGitHubCollaborators(
    fetchImpl,
    'https://api.github.com',
    'token',
    { owner: 'contoso', repo: 'docs' },
    [graph]
  );
  assert.equal(joined.externalHint, 'b2b-guest');
});

test('email input fails closed when GitHub public mail differs or is absent', async () => {
  const graph = makeSearchCandidate(
    subject('entra:tenant:maya', 'Maya Stewart', 'mayast'),
    'entra',
    'mayast',
    { mail: 'maya.stewart@contoso.example', assertedBy: 'entra' }
  );
  for (const email of ['other@contoso.example', null]) {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).includes('/users/')
        ? Response.json({
            node_id: 'U_maya',
            login: 'mayast_contoso',
            name: 'Maya Stewart',
            email,
          })
        : Response.json({
            data: {
              repository: {
                collaborators: {
                  nodes: [{ id: 'U_maya', login: 'mayast_contoso', name: 'Maya Stewart' }],
                },
              },
            },
          });
    assert.deepEqual(
      await joinGraphMailToGitHubCollaborators(
        fetchImpl,
        'https://api.github.com',
        'token',
        { owner: 'contoso', repo: 'docs' },
        [graph]
      ),
      []
    );
  }
});

test('ranking prefers exact matches, participants, and members without auto-selection', () => {
  const exact = makeSearchCandidate(subject('entra:t:1', 'Maya Stewart', 'mayast'), 'entra', 'mayast');
  const participant = makeSearchCandidate(subject('entra:t:2', 'Mayara Test', 'mayara'), 'participant', 'mayara');
  const guest = makeSearchCandidate(
    subject('entra:t:3', 'Maya Guest', 'maya_guest'),
    'entra',
    'maya_guest',
    { userPrincipalName: 'maya_example.net#EXT#@contoso.onmicrosoft.com' }
  );
  const ranked = rankIdentityCandidates(
    [guest, participant, exact],
    'mayast',
    new Set(['entra:t:2'])
  );
  assert.equal(ranked[0], exact);
  assert.equal(guest.externalHint, 'b2b-guest');
  assert.equal(ranked.length, 3);
});
