/**
 * Scripted fetch fake. The handler answers every request from test code; every call is
 * recorded (method, path, parsed body, Authorization header) for assertions.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
}

export type FakeHandler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly handler: FakeHandler) {}

  /** Bound reference shaped like the global fetch — pass as { fetchImpl }. */
  readonly call = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (init?.body != null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    const request: RecordedRequest = {
      method,
      url,
      path: url.replace(/^https?:\/\/[^/]+/, ""),
      authorization: headers.get("Authorization"),
      body,
    };
    this.requests.push(request);
    const answer = await this.handler(request);
    // 204/205/304 are null-body statuses — the fetch Response constructor
    // rejects a body on them (the real server logout answers a bare 204).
    const nullBody = answer.status === 204 || answer.status === 205 || answer.status === 304;
    return new Response(nullBody || answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
