const AZURE_DEVOPS_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const CLIENT_ID = import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined;
export const MICROSOFT_TENANT_ID =
  (import.meta.env.VITE_AZURE_TENANT_ID as string | undefined) || 'organizations';

const GRAPH_SCOPES = ['https://graph.microsoft.com/User.ReadBasic.All'];
const AZURE_DEVOPS_SCOPES = [`${AZURE_DEVOPS_RESOURCE_ID}/.default`];

export type GraphTransport = 'off' | 'msal';
export type AdoTransport = 'off' | 'direct-msal' | 'dev-cli';

function graphTransport(): GraphTransport {
  const configured = (import.meta.env.VITE_GRAPH_TRANSPORT as string | undefined)?.toLowerCase();
  if (configured === 'msal') return CLIENT_ID ? 'msal' : 'off';
  return 'off';
}

function adoTransport(): AdoTransport {
  const configured = (import.meta.env.VITE_ADO_TRANSPORT as string | undefined)?.toLowerCase();
  if (configured === 'direct-msal') return CLIENT_ID ? 'direct-msal' : 'off';
  if (configured === 'dev-cli') return import.meta.env.DEV ? 'dev-cli' : 'off';
  return 'off';
}

export const GRAPH_TRANSPORT = graphTransport();
export const ADO_TRANSPORT = adoTransport();
export const AZURE_AUTH_MODE: 'dev' | 'entra' | 'static' =
  ADO_TRANSPORT === 'dev-cli'
    ? 'dev'
    : ADO_TRANSPORT === 'direct-msal'
      ? 'entra'
      : 'static';
export const MICROSOFT_AUTH_MODE: 'entra' | 'static' =
  GRAPH_TRANSPORT === 'msal' || ADO_TRANSPORT === 'direct-msal' ? 'entra' : 'static';

export interface AzureAuthStatus {
  authenticated: boolean;
  login?: string;
  name?: string;
  objectId?: string;
  tenantId?: string;
}

let clientPromise: Promise<import('@azure/msal-browser').PublicClientApplication> | null = null;

function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

async function msalClient(): Promise<import('@azure/msal-browser').PublicClientApplication> {
  if (!CLIENT_ID) throw new Error('Microsoft sign-in is not configured.');
  if (!clientPromise) {
    clientPromise = import('@azure/msal-browser').then(async ({ PublicClientApplication }) => {
      const client = new PublicClientApplication({
        auth: {
          clientId: CLIENT_ID,
          authority: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`,
          redirectUri: redirectUri(),
        },
        cache: { cacheLocation: 'sessionStorage' },
      });
      await client.initialize();
      const redirect = await client.handleRedirectPromise();
      if (redirect?.account) client.setActiveAccount(redirect.account);
      return client;
    });
  }
  return clientPromise;
}

async function activeAccount() {
  const client = await msalClient();
  const account = client.getActiveAccount() || client.getAllAccounts()[0];
  if (account) client.setActiveAccount(account);
  return { client, account };
}

function interactionDetails(error: unknown): { claims?: string; requiresRedirect: boolean } {
  const value = error as { claims?: unknown; errorCode?: unknown; subError?: unknown };
  const claims = typeof value?.claims === 'string' && value.claims ? value.claims : undefined;
  const code = `${value?.errorCode || ''} ${value?.subError || ''}`.toLowerCase();
  return {
    claims,
    requiresRedirect:
      Boolean(claims) ||
      /interaction_required|login_required|consent_required|basic_action|additional_action/.test(
        code
      ),
  };
}

async function acquireMsalToken(scopes: string[], interactive: boolean): Promise<string> {
  const { client, account: existing } = await activeAccount();
  let account = existing;
  if (!account) {
    if (!interactive) return '';
    let login;
    try {
      login = await client.loginPopup({ scopes, prompt: 'select_account' });
    } catch (error) {
      const interaction = interactionDetails(error);
      if (!interaction.requiresRedirect) throw error;
      await client.loginRedirect({
        scopes,
        prompt: 'select_account',
        ...(interaction.claims ? { claims: interaction.claims } : {}),
      });
      return '';
    }
    account = login.account;
    if (!account) throw new Error('Microsoft Entra sign-in did not return an account.');
    client.setActiveAccount(account);
    if (login.accessToken) return login.accessToken;
  }
  try {
    return (await client.acquireTokenSilent({ account, scopes })).accessToken;
  } catch (error) {
    if (!interactive) return '';
    const interaction = interactionDetails(error);
    if (interaction.requiresRedirect) {
      await client.acquireTokenRedirect({
        account,
        scopes,
        ...(interaction.claims ? { claims: interaction.claims } : {}),
      });
      return '';
    }
    try {
      return (await client.acquireTokenPopup({ account, scopes })).accessToken;
    } catch (popupError) {
      const popupInteraction = interactionDetails(popupError);
      if (!popupInteraction.requiresRedirect) throw popupError;
      await client.acquireTokenRedirect({
        account,
        scopes,
        ...(popupInteraction.claims ? { claims: popupInteraction.claims } : {}),
      });
      return '';
    }
  }
}

export async function getAzureAuthStatus(): Promise<AzureAuthStatus> {
  // The local Azure CLI identity takes precedence when ADO runs in dev-cli mode:
  // it authenticates work-item authoring/editing even when Graph MSAL is enabled
  // only for people search. Otherwise enabling graph=msal would flip this to the
  // (initially unauthenticated) MSAL account and block ADO commenting until a
  // separate Microsoft sign-in. dev-cli only resolves in local dev builds.
  if (ADO_TRANSPORT === 'dev-cli') {
    const response = await fetch('/ado-auth/status');
    if (!response.ok) return { authenticated: false };
    const status = (await response.json()) as AzureAuthStatus;
    // The az CLI status carries no tenant/object id. Supply the configured tenant
    // so Graph people search (which needs a tenant) can run once the user grants
    // an on-demand Microsoft token.
    if (status?.authenticated && MICROSOFT_TENANT_ID && MICROSOFT_TENANT_ID !== 'organizations') {
      return { ...status, tenantId: status.tenantId || MICROSOFT_TENANT_ID };
    }
    return status;
  }
  if (MICROSOFT_AUTH_MODE === 'entra') {
    const { account } = await activeAccount();
    if (!account) return { authenticated: false };
    return {
      authenticated: true,
      login: account.username,
      name: account.name || account.username,
      objectId: account.localAccountId,
      tenantId: account.tenantId,
    };
  }
  return { authenticated: false };
}

export async function getGraphAccessToken(interactive: boolean): Promise<string> {
  if (GRAPH_TRANSPORT !== 'msal') {
    if (interactive) throw new Error('Microsoft Graph sign-in is not configured.');
    return '';
  }
  return acquireMsalToken(GRAPH_SCOPES, interactive);
}

export async function getAzureReposAccessToken(interactive: boolean): Promise<string> {
  if (ADO_TRANSPORT === 'dev-cli') return '';
  if (ADO_TRANSPORT !== 'direct-msal') {
    if (interactive) throw new Error('Azure DevOps access is not configured for this deployment.');
    return '';
  }
  return acquireMsalToken(AZURE_DEVOPS_SCOPES, interactive);
}

export async function startGraphLogin(): Promise<{ started: boolean } & AzureAuthStatus> {
  await getGraphAccessToken(true);
  return { started: true, ...(await getAzureAuthStatus()) };
}

export async function startAzureLogin(): Promise<{ started: boolean } & AzureAuthStatus> {
  if (ADO_TRANSPORT === 'dev-cli') {
    const response = await fetch('/ado-auth/login', { method: 'POST' });
    if (!response.ok) throw new Error(`Azure login failed (${response.status}).`);
    return response.json();
  }
  await getAzureReposAccessToken(true);
  return { started: true, ...(await getAzureAuthStatus()) };
}

export async function signOutAzure(): Promise<void> {
  if (MICROSOFT_AUTH_MODE === 'entra') {
    const { client, account } = await activeAccount();
    if (account) await client.logoutPopup({ account, mainWindowRedirectUri: redirectUri() });
  }
  if (ADO_TRANSPORT === 'dev-cli') await fetch('/ado-auth/logout', { method: 'POST' });
}