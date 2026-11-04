import { MirrorError } from "../errors.js";
import type { Protocol } from "../remote.js";
import type { GitConfig } from "./types.js";

export type Fetch = typeof globalThis.fetch;

export interface HttpResponse {
  status: number;
  data: unknown;
}

export interface TokenProviderConfig {
  /** Hostname used for SSH URLs and messages. */
  host: string;
  /** Web/API origin, e.g. https://gitlab.example.com or https://gitea.local:3000. */
  baseUrl: string;
  token: string;
  /** Env var the token came from, for error hints. */
  tokenSource: string;
  fetch: Fetch;
}

/**
 * Shared plumbing for providers that authenticate with an API token (GitLab, Gitea):
 * JSON requests with consistent error messages, and token-based git auth over HTTPS.
 */
export abstract class TokenProvider {
  abstract readonly label: string;
  /** Token scopes needed, for the 403 hint. */
  protected abstract readonly requiredScopes: string;
  protected abstract authHeaders(): Record<string, string>;
  private user?: Promise<string>;

  constructor(protected readonly config: TokenProviderConfig) {}

  get host(): string {
    return this.config.host;
  }

  protected abstract fetchCurrentUser(): Promise<string>;

  /** Cached: also serves as the credential check. */
  currentUser(): Promise<string> {
    this.user ??= this.fetchCurrentUser();
    return this.user;
  }

  async assertReady(): Promise<void> {
    await this.currentUser();
  }

  async defaultProtocol(): Promise<Protocol> {
    // The token authenticates HTTPS pushes (see gitAuth), so HTTPS works with no other setup.
    return "https";
  }

  repoUrl(namespace: string, repo: string, protocol: Protocol): string {
    return protocol === "ssh"
      ? `git@${this.config.host}:${namespace}/${repo}.git`
      : `${this.config.baseUrl}/${namespace}/${repo}.git`;
  }

  /**
   * Sends the token as HTTP Basic auth on git requests to this host. Passed through GIT_CONFIG_* env vars,
   * so it never appears in a URL, the process list, or git's output.
   */
  async gitAuth(url: string): Promise<GitConfig | undefined> {
    if (!url.toLowerCase().startsWith(`${this.config.baseUrl.toLowerCase()}/`)) return undefined;
    const user = await this.currentUser();
    const basic = Buffer.from(`${user}:${this.config.token}`).toString("base64");
    return { [`http.${this.config.baseUrl}/.extraHeader`]: `Authorization: Basic ${basic}` };
  }

  protected async request(method: string, path: string, body?: unknown): Promise<HttpResponse> {
    const url = `${this.config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.config.fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...this.authHeaders(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new MirrorError(
        `Cannot reach the ${this.label} API at ${this.config.baseUrl}: ${(error as Error).message}`,
        "Check the host, or pass --api-url if the API is served from a different address.",
      );
    }

    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body (an HTML error page, a proxy); keep the raw text for the message.
    }

    if (response.status === 401) {
      throw new MirrorError(
        `${this.label} rejected the token from ${this.config.tokenSource} for ${this.config.host}.`,
        "Check that the token is correct and has not expired.",
      );
    }
    if (response.status === 403) {
      throw new MirrorError(
        `The ${this.label} token is not allowed to ${method} ${path}.`,
        `The token needs ${this.requiredScopes}, and your account needs permission in that namespace.`,
      );
    }
    return { status: response.status, data };
  }

  protected fail(action: string, response: HttpResponse): never {
    throw new MirrorError(`${this.label} could not ${action} (HTTP ${response.status}).`, describe(response.data));
  }
}

/** Pulls a readable message out of GitLab ({message: {...}}) and Gitea ({message: "..."}) error bodies. */
function describe(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const message = record.message ?? record.error;
    if (typeof message === "string") return message;
    if (message && typeof message === "object") {
      return Object.entries(message)
        .map(([field, value]) => `${field} ${Array.isArray(value) ? value.join(", ") : String(value)}`)
        .join("; ");
    }
  }
  if (typeof data === "string" && data.trim()) return data.trim().slice(0, 200);
  return undefined;
}

export function field(data: unknown, key: string): unknown {
  return data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
}
