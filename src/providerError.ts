export type ProviderErrorKind =
  | 'signin-required'
  | 'not-configured'
  | 'forbidden'
  | 'transport';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number;

  constructor(kind: ProviderErrorKind, message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('Content-Type') || '';
  return /(?:^|\s|;)application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType);
}

async function jsonErrorMessage(response: Response, fallback: string): Promise<string> {
  if (!isJsonContentType(response)) return fallback;
  try {
    const payload = await response.clone().json();
    return payload?.message || payload?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

export async function requireProviderJson(
  response: Response,
  options: { provider: string; tokenSent: boolean }
): Promise<Response> {
  if (!isJsonContentType(response)) {
    if (response.status >= 200 && response.status < 400) {
      throw new ProviderError(
        'signin-required',
        `Sign in to Microsoft to load ${options.provider}.`,
        response.status
      );
    }
    throw new ProviderError(
      'transport',
      `${options.provider} returned an unexpected non-JSON response (${response.status}).`,
      response.status
    );
  }

  if (response.ok) return response;
  if (response.status === 401 || (response.status === 403 && !options.tokenSent)) {
    throw new ProviderError(
      'signin-required',
      `Sign in to Microsoft to load ${options.provider}.`,
      response.status
    );
  }
  if (response.status === 403) {
    throw new ProviderError(
      'forbidden',
      `Your account cannot read ${options.provider}.`,
      response.status
    );
  }
  const fallback = `${options.provider} request failed (${response.status}).`;
  throw new ProviderError(
    'transport',
    await jsonErrorMessage(response, fallback),
    response.status
  );
}
