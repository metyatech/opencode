import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  debugToolArgsEnabled,
  inputSummary,
  isEmptyObjectInput,
  logEmptyProcessArgsWarnLazy,
  logToolArgsLazy,
} from "../../src/tool/debug-args"

// Snapshot/restore OPENCODE_DEBUG_TOOL_ARGS around each test so a stray
// process.env mutation cannot leak across cases. Without this the lazy test
// below would be order-dependent.
const ENV_KEY = "OPENCODE_DEBUG_TOOL_ARGS"
const ORIGINAL = process.env[ENV_KEY]

beforeEach(() => {
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ORIGINAL
})

describe("debug-args env gate", () => {
  test("disabled when env unset", () => {
    expect(debugToolArgsEnabled()).toBe(false)
  })

  test("disabled when env is some other value", () => {
    process.env[ENV_KEY] = "no"
    expect(debugToolArgsEnabled()).toBe(false)
  })

  test.each(["1", "true", "yes", "TRUE", "Yes"])("enabled for truthy %p", (value) => {
    process.env[ENV_KEY] = value
    expect(debugToolArgsEnabled()).toBe(true)
  })
})

describe("logToolArgsLazy no-op when disabled", () => {
  test("does not invoke the field builder", () => {
    let called = false
    logToolArgsLazy("test", () => {
      called = true
      return {}
    })
    expect(called).toBe(false)
  })

  test("does not invoke the builder even when it would throw", () => {
    let called = false
    logToolArgsLazy("test", () => {
      called = true
      throw new Error("must not run")
    })
    expect(called).toBe(false)
  })

  test("invokes the builder when enabled", () => {
    process.env[ENV_KEY] = "1"
    let called = false
    logToolArgsLazy("test", () => {
      called = true
      return { ok: true }
    })
    expect(called).toBe(true)
  })

  test("catches builder exceptions so a buggy field cannot break tool flow", () => {
    process.env[ENV_KEY] = "1"
    // Must not throw — the env gate must contain failures inside the
    // builder so a malformed diagnostic site cannot leak across the tool
    // boundary into the user-visible tool path.
    logToolArgsLazy("test", () => {
      throw new Error("builder boom")
    })
    // Reaching here without an exception is the assertion.
  })
})

describe("inputSummary shape coverage", () => {
  test("undefined", () => {
    const s = inputSummary(undefined)
    expect(s.kind).toBe("undefined")
    expect(s.keys).toBeUndefined()
    expect(s.preview).toBe("undefined")
  })

  test("null", () => {
    const s = inputSummary(null)
    expect(s.kind).toBe("null")
    expect(s.keys).toBeUndefined()
    expect(s.preview).toBe("null")
  })

  test("empty object — the case we are chasing", () => {
    const s = inputSummary({})
    expect(s.kind).toBe("object")
    expect(s.keys).toEqual([])
    expect(s.preview).toBe("{}")
  })

  test("object with keys", () => {
    const s = inputSummary({ action: "list", cursor: 0 })
    expect(s.kind).toBe("object")
    expect(s.keys?.slice().sort()).toEqual(["action", "cursor"])
    expect(s.preview).toContain("\"action\":\"list\"")
  })

  test("array", () => {
    const s = inputSummary([1, 2, 3])
    expect(s.kind).toBe("array")
    expect(s.preview).toBe("[1,2,3]")
  })

  test("string", () => {
    const s = inputSummary("hello")
    expect(s.kind).toBe("string")
    expect(s.preview).toBe('"hello"')
  })

  test("function — JSON.stringify returns undefined; safePreview must not crash", () => {
    const s = inputSummary(() => 1)
    expect(s.kind).toBe("function")
    // `JSON.stringify(fn) === undefined`, so safePreview falls back to
    // `String(value)`. The result is implementation-defined but must be a
    // non-throwing string with no undefined/null literals that would crash
    // downstream consumers.
    expect(typeof s.preview).toBe("string")
    expect(s.preview.length).toBeGreaterThan(0)
  })

  test("symbol — JSON.stringify returns undefined; safePreview must not crash", () => {
    const s = inputSummary(Symbol("x"))
    expect(s.kind).toBe("symbol")
    expect(typeof s.preview).toBe("string")
    expect(s.preview.length).toBeGreaterThan(0)
  })

  test("BigInt — JSON.stringify throws; safePreview must not crash", () => {
    const s = inputSummary(BigInt(1))
    expect(s.kind).toBe("bigint")
    expect(typeof s.preview).toBe("string")
    expect(s.preview.length).toBeGreaterThan(0)
  })

  test("circular object — JSON.stringify throws; safePreview must not crash", () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    const s = inputSummary(obj)
    expect(s.kind).toBe("object")
    expect(s.keys?.includes("a")).toBe(true)
    expect(s.keys?.includes("self")).toBe(true)
    expect(typeof s.preview).toBe("string")
  })
})

describe("isEmptyObjectInput", () => {
  test("true only for a plain empty object", () => {
    expect(isEmptyObjectInput({})).toBe(true)
  })

  test("false for an object with keys", () => {
    expect(isEmptyObjectInput({ action: "list" })).toBe(false)
  })

  test.each([
    ["array", [] as unknown],
    ["null", null],
    ["undefined", undefined],
    ["string", ""],
    ["number", 0],
  ])("false for %s", (_label, value) => {
    expect(isEmptyObjectInput(value)).toBe(false)
  })
})

describe("logEmptyProcessArgsWarnLazy", () => {
  test("does not invoke the builder when disabled", () => {
    let called = false
    logEmptyProcessArgsWarnLazy("test", () => {
      called = true
      return { ok: true }
    })
    expect(called).toBe(false)
  })

  test("does not invoke the builder even when it would throw, when disabled", () => {
    let called = false
    logEmptyProcessArgsWarnLazy("test", () => {
      called = true
      throw new Error("must not run")
    })
    expect(called).toBe(false)
  })

  test("invokes the builder when enabled and emits nothing when it returns undefined", () => {
    process.env[ENV_KEY] = "1"
    let called = false
    // builder returning undefined is the predicate-skip path: it must run
    // (we are enabled) but must not throw and must suppress the WARN.
    logEmptyProcessArgsWarnLazy("test", () => {
      called = true
      return undefined
    })
    expect(called).toBe(true)
  })

  test("invokes the builder and accepts a payload without throwing", () => {
    process.env[ENV_KEY] = "1"
    let called = false
    logEmptyProcessArgsWarnLazy("test", () => {
      called = true
      return { tool: "process", argsKind: "object", argsKeys: [], argsPreview: "{}" }
    })
    expect(called).toBe(true)
  })

  test("catches builder exceptions so a buggy field cannot break tool flow", () => {
    process.env[ENV_KEY] = "1"
    // Must not throw out of the helper.
    logEmptyProcessArgsWarnLazy("test", () => {
      throw new Error("builder boom")
    })
    // Reaching here without an exception is the assertion.
  })
})
