import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"

// `packages/plugin` depends on the workspace `@opencode-ai/sdk` package, so
// the generated workspace SDK is the runtime source of truth for plugin client
// calls. These calls intentionally use `path.sessionID` without casts: if the
// SDK contract drifts back to `path.id`, this file fails to typecheck. The
// fetch capture also protects the runtime URL surface from silently producing
// `/session/undefined/...`.
describe("workspace SDK session path contract", () => {
  test("uses path.sessionID for all session endpoints consumed by plugins", async () => {
    const requests: Array<{ method: string; pathname: string }> = []
    const fetch: typeof globalThis.fetch = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        requests.push({ method: request.method, pathname: url.pathname })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const client = createOpencodeClient({ baseUrl: "http://sdk.test", fetch })
    const sessionID = "ses_contract"
    const messageID = "msg_contract"
    const text = { type: "text" as const, text: "hello" }
    const model = { providerID: "openai", modelID: "gpt-5.2" }

    await client.session.messages({ path: { sessionID } })
    await client.session.prompt({ path: { sessionID }, body: { parts: [text], model } })
    await client.session.promptAsync({ path: { sessionID }, body: { parts: [text], model } })
    await client.session.retry({ path: { sessionID, messageID }, body: { model } })
    await client.session.retryAsync({ path: { sessionID, messageID }, body: { model } })
    await client.session.summarize({ path: { sessionID }, body: { ...model } })
    await client.session.abort({ path: { sessionID } })
    await client.session.retryExact({
      path: { sessionID },
      body: { messageID, expectedProviderID: model.providerID, expectedModelID: model.modelID },
    })

    expect(requests).toEqual([
      { method: "GET", pathname: "/session/ses_contract/message" },
      { method: "POST", pathname: "/session/ses_contract/message" },
      { method: "POST", pathname: "/session/ses_contract/prompt_async" },
      { method: "POST", pathname: "/session/ses_contract/message/msg_contract/retry" },
      { method: "POST", pathname: "/session/ses_contract/message/msg_contract/retry_async" },
      { method: "POST", pathname: "/session/ses_contract/summarize" },
      { method: "POST", pathname: "/session/ses_contract/abort" },
      { method: "POST", pathname: "/session/ses_contract/retry-exact" },
    ])
    expect(requests.every((request) => !request.pathname.includes("undefined"))).toBe(true)
  })
})
