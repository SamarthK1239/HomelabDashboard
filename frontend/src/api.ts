/**
 * Thin fetch helpers for the dashboard API.
 *
 * The backend serves the built frontend from the same origin, and the Vite dev
 * server proxies `/api` through, so relative URLs work in both cases.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** True when an error is the result of an `AbortController` cancellation. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** A human-readable message for anything thrown by `fetch` or JSON parsing. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) {
    // `fetch` rejects with an opaque "Failed to fetch" when the server is down.
    return error.message === 'Failed to fetch'
      ? 'Cannot reach the dashboard backend'
      : error.message;
  }
  return String(error);
}

export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new ApiError(`${path} returned HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}
