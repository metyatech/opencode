import { describe, expect, test } from "bun:test"
import {
  CACHE_RELEVANT_HEADER_KEYS,
  computeFingerprint,
  computeFingerprintForRequest,
  type CanonicalCanonical,
} from "../../src/session/llm/invocation"

const baseCanonical = (overrides: Partial<CanonicalCanonical> = {}): CanonicalCanonical => ({
  model: {
    providerID: "openai",
    modelID: "gpt-5.2",
    apiID: "gpt-5.2",
  },
  system: ["You are a helpful assistant."],
  messages: [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ],
  tools: [],
  toolChoice: "auto",
  params: {
    temperature: 0.4,
    topP: 0.8,
    options: { openai: { reasoningEffort: "high" } },
  },
  headers: {
    "x-opencode-project": "project-1",
    "x-opencode-session": "session-1",
  },
  promptCacheKey: "session-1",
  ...overrides,
})

describe("session.llm.invocation.computeFingerprint", () => {
  test("is stable for identical inputs", () => {
    const a = computeFingerprint(baseCanonical())
    const b = computeFingerprint(baseCanonical())
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test("tool order does not change the fingerprint (sorted by name)", () => {
    const a = computeFingerprint(
      baseCanonical({
        tools: [
          { name: "alpha", description: "A" },
          { name: "bravo", description: "B" },
          { name: "charlie", description: "C" },
        ],
      }),
    )
    const b = computeFingerprint(
      baseCanonical({
        tools: [
          { name: "charlie", description: "C" },
          { name: "alpha", description: "A" },
          { name: "bravo", description: "B" },
        ],
      }),
    )
    expect(a).toBe(b)
  })

  test("tool list reorder produces the same fingerprint when input was already sorted", () => {
    const tools = [
      { name: "alpha", description: "A" },
      { name: "bravo", description: "B" },
    ]
    const base = computeFingerprint(baseCanonical({ tools }))
    // Same tools re-serialized into a fresh array. The fingerprint must
    // hold because tools are sorted by name before hashing.
    const reordered = [...tools]
    const after = computeFingerprint(baseCanonical({ tools: reordered }))
    expect(base).toBe(after)
  })

  test("system prompt change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ system: ["v1"] }))
    const b = computeFingerprint(baseCanonical({ system: ["v2"] }))
    expect(a).not.toBe(b)
  })

  test("messages change produces a different fingerprint", () => {
    const a = computeFingerprint(
      baseCanonical({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }),
    )
    const b = computeFingerprint(
      baseCanonical({
        messages: [{ role: "user", content: [{ type: "text", text: "Different" }] }],
      }),
    )
    expect(a).not.toBe(b)
  })

  test("tool name change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ tools: [{ name: "alpha" }] }))
    const b = computeFingerprint(baseCanonical({ tools: [{ name: "beta" }] }))
    expect(a).not.toBe(b)
  })

  test("toolChoice change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ toolChoice: "auto" }))
    const b = computeFingerprint(baseCanonical({ toolChoice: "required" }))
    expect(a).not.toBe(b)
  })

  test("temperature change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ params: { ...baseCanonical().params, temperature: 0.1 } }))
    const b = computeFingerprint(baseCanonical({ params: { ...baseCanonical().params, temperature: 0.2 } }))
    expect(a).not.toBe(b)
  })

  test("topP change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ params: { ...baseCanonical().params, topP: 0.7 } }))
    const b = computeFingerprint(baseCanonical({ params: { ...baseCanonical().params, topP: 0.8 } }))
    expect(a).not.toBe(b)
  })

  test("topK change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ params: { ...baseCanonical().params, topK: 10 } }))
    const b = computeFingerprint(baseCanonical({ params: { ...baseCanonical().params, topK: 20 } }))
    expect(a).not.toBe(b)
  })

  test("maxOutputTokens change produces a different fingerprint", () => {
    const a = computeFingerprint(
      baseCanonical({ params: { ...baseCanonical().params, maxOutputTokens: 1024 } }),
    )
    const b = computeFingerprint(
      baseCanonical({ params: { ...baseCanonical().params, maxOutputTokens: 2048 } }),
    )
    expect(a).not.toBe(b)
  })

  test("reasoning effort change produces a different fingerprint", () => {
    const a = computeFingerprint(
      baseCanonical({
        params: { ...baseCanonical().params, options: { openai: { reasoningEffort: "low" } } },
      }),
    )
    const b = computeFingerprint(
      baseCanonical({
        params: { ...baseCanonical().params, options: { openai: { reasoningEffort: "high" } } },
      }),
    )
    expect(a).not.toBe(b)
  })

  test("variant change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ model: { ...baseCanonical().model, variant: "low" } }))
    const b = computeFingerprint(baseCanonical({ model: { ...baseCanonical().model, variant: "high" } }))
    expect(a).not.toBe(b)
  })

  test("model apiID change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ model: { ...baseCanonical().model, apiID: "gpt-5.2" } }))
    const b = computeFingerprint(baseCanonical({ model: { ...baseCanonical().model, apiID: "gpt-5.1" } }))
    expect(a).not.toBe(b)
  })

  test("promptCacheKey change produces a different fingerprint", () => {
    const a = computeFingerprint(baseCanonical({ promptCacheKey: "session-1" }))
    const b = computeFingerprint(baseCanonical({ promptCacheKey: "session-2" }))
    expect(a).not.toBe(b)
  })

  test("Authorization header is excluded", () => {
    const a = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, Authorization: "Bearer x" } }))
    const b = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, Authorization: "Bearer y" } }))
    expect(a).toBe(b)
  })

  test("User-Agent header is excluded", () => {
    const a = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, "User-Agent": "ua-1" } }))
    const b = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, "User-Agent": "ua-2" } }))
    expect(a).toBe(b)
  })

  test("x-opencode-session header is excluded", () => {
    const a = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, "x-opencode-session": "s1" } }))
    const b = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, "x-opencode-session": "s2" } }))
    expect(a).toBe(b)
  })

  test("x-opencode-request header is excluded", () => {
    const a = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, "x-opencode-request": "r1" } }))
    const b = computeFingerprint(baseCanonical({ headers: { ...baseCanonical().headers, "x-opencode-request": "r2" } }))
    expect(a).toBe(b)
  })

  test("cache-relevant headers are NOT excluded (changing them changes the fingerprint)", () => {
    const a = computeFingerprint(
      baseCanonical({ headers: { ...baseCanonical().headers, "x-opencode-project": "p1" } }),
    )
    const b = computeFingerprint(
      baseCanonical({ headers: { ...baseCanonical().headers, "x-opencode-project": "p2" } }),
    )
    expect(a).not.toBe(b)
  })

  test("CACHE_RELEVANT_HEADER_KEYS documents the allow-list", () => {
    expect(CACHE_RELEVANT_HEADER_KEYS).toContain("x-opencode-project")
    expect(CACHE_RELEVANT_HEADER_KEYS).toContain("x-opencode-session")
  })

  test("computeFingerprintForRequest returns a stable value across reformulation", () => {
    const input = {
      model: { providerID: "openai", modelID: "gpt-5.2", apiID: "gpt-5.2" },
      system: ["You are concise."],
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] as never,
      tools: {} as never,
      toolChoice: "auto" as const,
      params: {
        temperature: 0.3,
        topP: 0.9,
        options: { openai: { reasoningEffort: "high" } },
      },
      headers: {
        "x-opencode-project": "p1",
        Authorization: "Bearer secret",
        "User-Agent": "opencode/1.0",
      },
      promptCacheKey: "session-1",
    }
    const a = computeFingerprintForRequest(input)
    const b = computeFingerprintForRequest({
      ...input,
      headers: {
        ...input.headers,
        Authorization: "Bearer different",
        "User-Agent": "opencode/2.0",
      },
    })
    expect(a).toBe(b)
  })
})
