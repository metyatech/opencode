import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ProcessManager } from "@/process-manager"
import { ProcessTool } from "@/process-manager/tool"
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
      expect(def.description).toContain('{"action":"list"}')
      expect(def.description).toContain('{"action":"poll","handle":"proc_...","cursor":0}')
      expect(def.description).toContain('{"action":"stop","handle":"proc_..."}')
      expect(def.description).toContain('If you need a handle but do not know it, call {"action":"list"} first.')
    }),
  )

  it.instance("process({}) error contains concrete JSON examples", () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* ProcessTool)
      const exit = yield* Effect.exit(def.execute({} as never, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const err = Cause.squash(exit.cause) as Error
      const message = err.message
      expect(message).toContain("The process tool requires an action and must never be called with empty arguments.")
      expect(message).toContain('{"action":"list"}')
      expect(message).toContain('{"action":"poll","handle":"proc_...","cursor":0}')
      expect(message).toContain('{"action":"stop","handle":"proc_..."}')
      expect(message).toContain('If the handle is unknown, call {"action":"list"} first.')
      expect(message).toContain("Original schema error:")
    }),
  )

  it.instance("formatValidationError produces the expected message shape", () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* ProcessTool)
      const formatted = def.formatValidationError!(new Error("boom"))
      expect(formatted).toContain("The process tool requires an action and must never be called with empty arguments.")
      expect(formatted).toContain('{"action":"list"}')
      expect(formatted).toContain('{"action":"poll","handle":"proc_...","cursor":0}')
      expect(formatted).toContain('{"action":"stop","handle":"proc_..."}')
      expect(formatted).toContain('If the handle is unknown, call {"action":"list"} first.')
      expect(formatted).toContain("Original schema error: Error: boom")
    }),
  )
})
