import type { ViewState } from '../../src/core/types';

type Route = unknown;

/** Fake fetch: JSON bodies, Uint8Array bodies, or a number for an HTTP status. Unknown URLs → 404. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!(url in routes)) return new Response('not found', { status: 404 });
    const body = routes[url];
    if (typeof body === 'number') return new Response('', { status: body });
    if (body instanceof Uint8Array) return new Response(body as Uint8Array<ArrayBuffer>);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return Object.assign(fn, { calls, routes });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets fetch/Response/json chains settle (Node's Response.json may need several ticks). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

export function view(over: Partial<ViewState> = {}): ViewState {
  return {
    zoom: 16,
    pitch: 0,
    bearing: 0,
    center: [2.2945, 48.8584],
    bounds: [2.285, 48.853, 2.304, 48.864],
    ...over,
  };
}
