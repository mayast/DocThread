/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GH_CLIENT_ID?: string;
  readonly VITE_OAUTH_PROXY?: string;
  readonly VITE_AZURE_CLIENT_ID?: string;
  readonly VITE_AZURE_TENANT_ID?: string;
  readonly VITE_GRAPH_TRANSPORT?: 'off' | 'msal';
  readonly VITE_ADO_TRANSPORT?: 'off' | 'direct-msal' | 'dev-cli';
  readonly VITE_NOTIFY_ALLOWED_DOMAINS?: string;
  readonly VITE_TEAMS_NOTIFY?: string;
  readonly VITE_SUMMARIZE_ENDPOINT?: string;
  readonly VITE_SUGGEST_ENDPOINT?: string;
  readonly VITE_READINESS_ENDPOINT?: string;
  readonly VITE_REVIEW_ENDPOINT?: string;
  readonly VITE_SKILL_PATHS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
