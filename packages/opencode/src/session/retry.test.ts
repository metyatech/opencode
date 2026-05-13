import { describe, expect, test } from "bun:test"
import { MessageV2 } from "./message-v2"
import { SessionRetry } from "./retry"

// SessionRetry.retryable receives the toObject() form of NamedError instances
// (NamedError.toObject() returns { name, data }). Build that shape directly so
// the test exercises the same input the production policy() receives.
const API_ERROR_NAME = new MessageV2.APIError({ isRetryable: false, message: "" }).name

const apiError = (data: {
  message: string
  statusCode?: number
  isRetryable?: boolean
  responseBody?: string
}) =>
  ({
    name: API_ERROR_NAME,
    data: {
      message: data.message,
      statusCode: data.statusCode,
      isRetryable: data.isRetryable ?? true,
      responseBody: data.responseBody,
    },
  }) as Parameters<typeof SessionRetry.retryable>[0]

describe("SessionRetry.retryable", () => {
  test("Claude Code 'Claude Code returned an error result' is terminal", () => {
    const err = apiError({
      message: "Claude Code returned an error result: You've hit your limit \u00b7 resets May 15, 3am (Asia/Tokyo)",
      statusCode: 500,
      isRetryable: true,
    })

    expect(SessionRetry.retryable(err)).toBeUndefined()
  })

  test("Claude Code 'You've hit your limit' is terminal even when proxy returns 500", () => {
    const err = apiError({
      message: "Claude Code returned an error result: You've hit your limit \u00b7 resets May 1, 3am",
      statusCode: 500,
      isRetryable: true,
    })

    expect(SessionRetry.retryable(err)).toBeUndefined()
  })

  test("variant 'hit your limit \u2022 resets ...' is also terminal", () => {
    const err = apiError({
      message: "hit your limit \u2022 resets tomorrow at 09:00",
      statusCode: 500,
    })

    expect(SessionRetry.retryable(err)).toBeUndefined()
  })

  test("billing hard limit / payment required / out of credits stop retry", () => {
    const cases = [
      "Billing hard limit reached",
      "Payment Required",
      "Out of credits, please top up",
      "Subscription quota exceeded",
      "Monthly limit reached",
      "Quota will reset after 2025-05-01",
      "Usage limit has been reached for this month",
    ]

    for (const message of cases) {
      const err = apiError({ message, statusCode: 500 })
      expect(SessionRetry.retryable(err)).toBeUndefined()
    }
  })

  test("plain transient 5xx without quota text remains retryable", () => {
    const err = apiError({
      message: "Internal Server Error",
      statusCode: 500,
    })

    expect(SessionRetry.retryable(err)).toBe("Internal Server Error")
  })

  test("'Overloaded' 5xx still maps to overloaded message", () => {
    const err = apiError({
      message: "Overloaded: try again later",
      statusCode: 503,
    })

    expect(SessionRetry.retryable(err)).toBe("Provider is overloaded")
  })

  test("rate limit text on a non-APIError stays retryable", () => {
    const err = {
      name: "AI_APICallError",
      data: { message: "Too Many Requests: rate limit reached" },
    } as unknown as Parameters<typeof SessionRetry.retryable>[0]

    expect(SessionRetry.retryable(err)).toBe("Too Many Requests: rate limit reached")
  })

  test("plain non-APIError quota exhaustion is terminal", () => {
    const err = {
      name: "AI_APICallError",
      data: { message: "You've hit your limit \u00b7 resets May 1, 3am" },
    } as unknown as Parameters<typeof SessionRetry.retryable>[0]

    expect(SessionRetry.retryable(err)).toBeUndefined()
  })
})
