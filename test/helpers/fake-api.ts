import type { Fetch } from "../../src/core/providers/http.js";

export interface ApiRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ApiReply {
  status: number;
  body?: unknown;
}

/** `"GET /api/v4/user"` -> reply (or a function computing one from the request). */
export type Routes = Record<string, ApiReply | ((request: ApiRequest) => ApiReply)>;

/** A fetch() that answers from a route table and records every request. Unknown routes return 404. */
export function createFakeFetch(routes: Routes) {
  const requests: ApiRequest[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    const request: ApiRequest = {
      method: init?.method ?? "GET",
      url,
      // Keep the path exactly as sent (encoded), which is what the APIs match on.
      path: url.slice(parsed.origin.length),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const route = routes[`${request.method} ${request.path}`];
    const reply = typeof route === "function" ? route(request) : (route ?? { status: 404, body: { message: "404 Not Found" } });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  };
  const calls = () => requests.map((request) => `${request.method} ${request.path}`);
  return { fetch, requests, calls };
}

/** A stateful fake GitLab: projects can be created and then exist. */
export function fakeGitLab({ user = "jane", groups = { "team/sub": 42 } as Record<string, number> } = {}) {
  const projects = new Set<string>();
  const routes: Routes = {
    "GET /api/v4/user": { status: 200, body: { username: user } },
    "POST /api/v4/projects": (request) => {
      const body = request.body as { path: string; namespace_id?: number };
      const namespace = body.namespace_id === undefined ? user : Object.keys(groups).find((g) => groups[g] === body.namespace_id);
      projects.add(`${namespace}/${body.path}`);
      return { status: 201, body: { id: 1 } };
    },
  };
  for (const [group, id] of Object.entries(groups)) {
    routes[`GET /api/v4/namespaces/${encodeURIComponent(group)}`] = { status: 200, body: { id, full_path: group } };
  }
  const api = createFakeFetch(
    new Proxy(routes, {
      get(target, key: string) {
        const match = /^GET \/api\/v4\/projects\/(.+)$/.exec(key);
        if (match) return { status: projects.has(decodeURIComponent(match[1]!)) ? 200 : 404, body: {} };
        return target[key];
      },
    }),
  );
  return { ...api, projects };
}
