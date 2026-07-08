import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ProcessManager } from "@/process-manager"
import { ProcessTool, normalizeProcessToolArgs } from "@/process-manager/tool"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const layer = Layer.mergeAll(
  Config.defaultLayer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  RuntimeFlags.defaultLayer,
  ProcessManager.defaultLayer,
)
const it = testEffect(layer)

const ctx = {
  sessionID: SessionID.make("ses_process_tool_test"),
  messageID: MessageID.make("msg_process_tool_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("process tool action guidance", () => {
  it.instance("description contains concrete JSON examples", () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* ProcessTool)
      expect(def.description).toContain("Never call this tool with empty arguments.")
      expect(def.description).toContain("not killed merely because elapsed time passes after yielding")
      expect(def.description).toContain("keeps up to 64 global processes")
      expect(def.description).toContain("live processes")
      expect(def.description).toContain('{"action":"list"}')
      expect(def.description).toContain('{"action":"poll","handle":"proc_...","cursor":0}')
      expect(def.description).toContain('{"action":"stop","handle":"proc_..."}')
      expect(def.description).toContain('If you need a handle but do not know it, call {"action":"list"} first.')
      expect(def.description).not.toContain("hard timeout")
      // Long-poll guidance must mention the required contracts.
      expect(def.description).toContain(
        "Do not re-run the original shell command just to wait for completion; that starts a second process.",
      )
      expect(def.description).toContain("poll again using that result's next_cursor")
      expect(def.description).toContain("stop it only if you intend to terminate it")
      // Forbidden phrases must not appear in the description.
      expect(def.description).not.toContain("previous next_cursor")
      expect(def.description).not.toContain("same cursor")
      expect(def.description).not.toContain("reaped by the manager")
      // No write action must still be advertised as absent.
      expect(def.description).toContain('There is intentionally no `write` action')
    }),
  )

  it.instance("process({}) is normalized to list", () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* ProcessTool)
      const result = yield* def.execute({} as never, ctx)

      expect(result.title).toBe("list")
      expect(result.metadata.action).toBe("list")

      const parsed = JSON.parse(result.output) as { processes?: unknown[] }
      expect(Array.isArray(parsed.processes)).toBe(true)
    }),
  )

  it.instance("formatValidationError produces the expected message shape", () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* ProcessTool)
      const formatted = def.formatValidationError!(new Error("boom"), {})
      expect(formatted).toContain("The process tool requires an action and must never be called with empty arguments.")
      expect(formatted).toContain('{"action":"list"}')
      expect(formatted).toContain('{"action":"poll","handle":"proc_...","cursor":0}')
      expect(formatted).toContain('{"action":"stop","handle":"proc_..."}')
      expect(formatted).toContain('If the handle is unknown, call {"action":"list"} first.')
      expect(formatted).toContain("Original schema error: Error: boom")
    }),
  )

  it.instance("process poll with non-numeric string cursor reports typed-field guidance", () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* ProcessTool)
      const exit = yield* Effect.exit(
        def.execute({ action: "poll", handle: "proc_cursor", cursor: "abc" } as never, ctx),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const err = Cause.squash(exit.cause) as Error
      const message = err.message
      expect(message).toContain("Invalid process tool arguments.")
      expect(message).toContain("cursor/wait_ms/max_bytes must be numbers when provided")
      expect(message).not.toContain("must never be called with empty arguments")
      expect(message).toContain("Original schema error:")
      expect(message).toContain('"abc"')
      expect(message).toContain('["cursor"]')
    }),
  )

  it.instance("process poll with decimal-integer cursor string is normalized and accepted", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const info = yield* manager.promote({
        sessionID: ctx.sessionID as unknown as string,
        command: "x",
        cwd: "/",
        pid: 9101,
        stdinAvailable: false,
        child: { pid: 9101, exitCode: Effect.succeed(0), kill: () => {} },
        prePromoteOutput: { stdout: "hi\n", stderr: "" },
      })
      const def = yield* Tool.init(yield* ProcessTool)
      // The LLM sent cursor as a decimal-integer string. The normalizer must
      // coerce it to a number so the schema accepts the call; the manager
      // then sees the same numeric shape it has always accepted.
      const result = yield* def.execute(
        { action: "poll", handle: info.handle, cursor: "0", wait_ms: "180000", max_bytes: "65536" } as never,
        ctx,
      )
      const parsed = JSON.parse(result.output) as { wait_status?: string }
      expect(parsed.wait_status).toBeDefined()
      expect(["immediate", "output", "terminal", "timeout"]).toContain(parsed.wait_status!)
    }),
  )
})

describe("process tool poll output", () => {
  it.instance("poll output JSON includes wait_status", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const info = yield* manager.promote({
        sessionID: ctx.sessionID as unknown as string,
        command: "x",
        cwd: "/",
        pid: 9100,
        stdinAvailable: false,
        child: { pid: 9100, exitCode: Effect.succeed(0), kill: () => {} },
        prePromoteOutput: { stdout: "hi\n", stderr: "" },
      })
      const def = yield* Tool.init(yield* ProcessTool)
      const result = yield* def.execute({ action: "poll", handle: info.handle, cursor: 0 } as never, ctx)
      const parsed = JSON.parse(result.output) as { wait_status?: string }
      expect(parsed.wait_status).toBeDefined()
      expect(["immediate", "output", "terminal", "timeout"]).toContain(parsed.wait_status!)
    }),
  )
})

describe("normalizeProcessToolArgs", () => {
  test("converts decimal-integer poll numerics to numbers", () => {
    const input = {
      action: "poll",
      handle: "proc_test",
      cursor: "0",
      wait_ms: "180000",
      max_bytes: "65536",
    }
    const output = normalizeProcessToolArgs(input) as Record<string, unknown>
    expect(output).toEqual({
      action: "poll",
      handle: "proc_test",
      cursor: 0,
      wait_ms: 180000,
      max_bytes: 65536,
    })
    expect(typeof output.cursor).toBe("number")
    expect(typeof output.wait_ms).toBe("number")
    expect(typeof output.max_bytes).toBe("number")
  })

  test("leaves numeric poll inputs untouched", () => {
    const input = {
      action: "poll",
      handle: "proc_test",
      cursor: 0,
      wait_ms: 300000,
      max_bytes: 65536,
    }
    // Reference-equal when nothing changed: the wrapper can skip work.
    expect(normalizeProcessToolArgs(input)).toBe(input)
  })

  test.each([
    ["empty string", ""],
    ["non-numeric", "abc"],
    ["decimal point", "1.5"],
    ["negative", "-1"],
    ["hex prefix", "0x10"],
    ["leading zero", "01"],
    ["whitespace", " 1"],
  ])("does not convert invalid cursor value (%s)", (_label, invalid) => {
    const input = { action: "poll", handle: "proc_test", cursor: invalid }
    const output = normalizeProcessToolArgs(input) as Record<string, unknown>
    expect(output.cursor).toBe(invalid)
    expect(typeof output.cursor).toBe("string")
  })

  test("does not normalize list action", () => {
    const input = { action: "list", cursor: "0" }
    expect(normalizeProcessToolArgs(input)).toBe(input)
  })

  test("does not normalize stop action", () => {
    const input = { action: "stop", handle: "proc_test", cursor: "0" }
    expect(normalizeProcessToolArgs(input)).toBe(input)
  })

  test("does not infer action for non-empty object without action", () => {
    const input = { handle: "proc_test" }
    expect(normalizeProcessToolArgs(input)).toBe(input)
  })

  test("normalizes empty object to list action", () => {
    expect(normalizeProcessToolArgs({})).toEqual({ action: "list" })
  })

  test("returns null unchanged", () => {
    expect(normalizeProcessToolArgs(null)).toBe(null)
  })

  test("returns array unchanged", () => {
    const input: unknown = [{ action: "poll", cursor: "0" }]
    expect(normalizeProcessToolArgs(input)).toBe(input)
  })

  test("returns primitive unchanged", () => {
    expect(normalizeProcessToolArgs("poll")).toBe("poll")
    expect(normalizeProcessToolArgs(42)).toBe(42)
    expect(normalizeProcessToolArgs(true)).toBe(true)
    expect(normalizeProcessToolArgs(undefined)).toBe(undefined)
  })

  test("does not convert strings beyond Number.MAX_SAFE_INTEGER", () => {
    // 2^53 = 9007199254740992 is the first integer Number cannot represent
    // exactly; the next one exceeds the safe-integer range.
    const overflow = "9007199254740993"
    const input = { action: "poll", handle: "proc_test", cursor: overflow }
    const output = normalizeProcessToolArgs(input) as Record<string, unknown>
    expect(output.cursor).toBe(overflow)
    expect(typeof output.cursor).toBe("string")
  })

  test("only touches the three documented poll numeric fields", () => {
    const input = {
      action: "poll",
      handle: "proc_test",
      cursor: "0",
      // `foo` is not one of cursor/wait_ms/max_bytes and must NOT be coerced
      // even though it happens to be a valid integer string. Silently
      // widening the field set would mask real caller mistakes.
      foo: "1",
    }
    const output = normalizeProcessToolArgs(input) as Record<string, unknown>
    expect(output.cursor).toBe(0)
    expect(output.foo).toBe("1")
  })

  test("omitted fields are not introduced as undefined", () => {
    const input = { action: "poll", handle: "proc_test" }
    const output = normalizeProcessToolArgs(input)
    // Reference-equal when nothing changed.
    expect(output).toBe(input)
    expect(Object.prototype.hasOwnProperty.call(output, "cursor")).toBe(false)
  })
})
