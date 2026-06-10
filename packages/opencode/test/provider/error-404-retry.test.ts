import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "../../src/provider/error"

function makeApiError(input: {
  statusCode?: number
  responseBody?: string
  isRetryable?: boolean
  message?: string
}): APICallError {
  return new APICallError({
    message: input.message ?? "boom",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: input.statusCode,
    responseBody: input.responseBody,
    isRetryable: input.isRetryable,
  })
}

describe("ProviderError.parseAPICallError", () => {
  test("#given openai 404 with model_not_found body #when parsed #then isRetryable is false (session-loss signal, not transient)", () => {
    // given — Copilot 404 with a "model not found" body. This is the exact
    // shape produced by github-copilot when a long-idle session has lost
    // its server-side state and the user's prompt references a model that
    // the server can no longer resolve. Treating it as retryable walks the
    // runtime-fallback chain all the way to the terminal model and surfaces
    // "Requested entity was not found." to the user while they were just
    // thinking about their reply.
    const error = makeApiError({
      statusCode: 404,
      responseBody: JSON.stringify({ error: { code: "model_not_found", message: "Requested entity was not found." } }),
      isRetryable: false,
    })

    // when
    const parsed = ProviderError.parseAPICallError({ providerID: "github-copilot" as never, error })

    // then
    expect(parsed.type).toBe("api_error")
    if (parsed.type === "api_error") {
      expect(parsed.isRetryable).toBe(false)
      expect(parsed.statusCode).toBe(404)
    }
  })

  test("#given openai 404 with transient body #when parsed #then isRetryable is true (transient 404s still retry, preserves legacy behaviour)", () => {
    // given — a 404 whose body does NOT contain "model not found". The
    // original comment in isOpenAiErrorRetryable noted that "openai
    // sometimes returns 404 for models that are actually available"; that
    // case must still be retryable. The new check inspects the body and
    // only blocks the retry when the body confirms a missing model.
    const error = makeApiError({
      statusCode: 404,
      responseBody: JSON.stringify({ error: { message: "Upstream temporarily unavailable" } }),
      isRetryable: false,
    })

    // when
    const parsed = ProviderError.parseAPICallError({ providerID: "openai" as never, error })

    // then
    expect(parsed.type).toBe("api_error")
    if (parsed.type === "api_error") {
      expect(parsed.isRetryable).toBe(true)
    }
  })

  test("#given openai 404 with model_not_found body and isRetryable=true #when parsed #then isRetryable is false (body check wins)", () => {
    // given — Copilot provider SDK might still set isRetryable=true on the
    // raw error. The body check must override it because "model not found"
    // is a hard lookup failure, not a transient provider hiccup.
    const error = makeApiError({
      statusCode: 404,
      responseBody: JSON.stringify({ error: { code: "model_not_found", message: "Requested entity was not found." } }),
      isRetryable: true,
    })

    // when
    const parsed = ProviderError.parseAPICallError({ providerID: "github-copilot" as never, error })

    // then
    expect(parsed.type).toBe("api_error")
    if (parsed.type === "api_error") {
      expect(parsed.isRetryable).toBe(false)
    }
  })

  test("#given openai 500 #when parsed #then isRetryable is true (unchanged behaviour for genuine transient failures)", () => {
    // given — 5xx errors are always transient and must remain retryable.
    const error = makeApiError({ statusCode: 500, isRetryable: true })

    // when
    const parsed = ProviderError.parseAPICallError({ providerID: "openai" as never, error })

    // then
    expect(parsed.type).toBe("api_error")
    if (parsed.type === "api_error") {
      expect(parsed.isRetryable).toBe(true)
      expect(parsed.statusCode).toBe(500)
    }
  })

  test("#given openai 429 #when parsed #then isRetryable is true (rate limit remains retryable)", () => {
    // given
    const error = makeApiError({ statusCode: 429, isRetryable: true })

    // when
    const parsed = ProviderError.parseAPICallError({ providerID: "openai" as never, error })

    // then
    expect(parsed.type).toBe("api_error")
    if (parsed.type === "api_error") {
      expect(parsed.isRetryable).toBe(true)
      expect(parsed.statusCode).toBe(429)
    }
  })

  test("#given openai 404 with empty body and isRetryable=true #when parsed #then isRetryable is true (no false negative when body is empty)", () => {
    // given — a 404 with no body must not be misclassified as a missing
    // model. The body check must require the explicit "model not found"
    // marker to flip the retry decision.
    const error = makeApiError({ statusCode: 404, isRetryable: true, responseBody: "" })

    // when
    const parsed = ProviderError.parseAPICallError({ providerID: "github-copilot" as never, error })

    // then
    expect(parsed.type).toBe("api_error")
    if (parsed.type === "api_error") {
      expect(parsed.isRetryable).toBe(true)
    }
  })
})
