export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function pick(value: string | null, fallback?: string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (value === encodeURIComponent(fallback)) return fallback
  return value
}

function rewrite(request: Request, directory?: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const value = pick(request.headers.get("x-opencode-directory"), directory)
  if (!value) return request

  const url = new URL(request.url)
  if (!url.searchParams.has("directory")) {
    url.searchParams.set("directory", value)
  }

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  return next
}

// Preserve the legacy v1 SDK plugin-contract call shape. Stale plugins
// (or any caller built against the pre-rename schema) pass `path.id` for
// session endpoints, but the current generated SDK substitutes the URL
// template using `path.sessionID`, so the wire path becomes `/session/`
// instead of `/session/{id}` and the server falls through to an unrelated
// route that surfaces as a 500 UnknownError. Normalize here, inside
// requestValidator (the only hook that runs BEFORE buildUrl), so the
// generated URL substitution sees both fields. Existing callers that
// already pass `path.sessionID` are left untouched, and `id` is kept on
// the object so downstream consumers that read it still work.
function normalizeLegacySessionPath(data: unknown) {
  if (!data || typeof data !== "object") return

  const options = data as {
    url?: unknown
    path?: Record<string, unknown>
  }

  if (typeof options.url !== "string") return
  if (!options.url.includes("{sessionID}")) return
  if (!options.path || typeof options.path !== "object") return
  if (options.path.sessionID !== undefined) return
  if (options.path.id === undefined || options.path.id === null) return

  options.path = {
    ...options.path,
    sessionID: options.path.id,
  }
}

export function createOpencodeClient(config?: Config & { directory?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  const userRequestValidator = config?.requestValidator
  const wrappedValidator: NonNullable<Config["requestValidator"]> = async (data) => {
    normalizeLegacySessionPath(data)
    return await userRequestValidator?.(data)
  }
  config = {
    ...config,
    requestValidator: wrappedValidator,
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory),
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) => rewrite(request, config?.directory))
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
