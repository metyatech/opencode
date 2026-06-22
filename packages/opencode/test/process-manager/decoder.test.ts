import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProcessManager } from "../../src/process-manager/service"
import { ProcessHandle } from "../../src/process-manager/id"
import { testEffect } from "../lib/effect"

// UTF-8 regression tests for the manager's drainStream path. The v2
// regression was: each chunk decoded with a fresh TextDecoder, which
// resets the internal byte buffer between chunks. A multi-byte
// sequence split across two chunks (e.g. "こ" = E3 81 93 split as
// "E3 81" + "93") decoded per-chunk turns into "ã\x81" + the
// U+FFFD replacement. The fix is to keep ONE TextDecoder alive
// across the entire stream and feed it chunks sequentially via
// `decoder.decode(chunk, { stream: true })`, then flush with
// `decoder.decode()` at end-of-stream.

const baseLayer = Layer.mergeAll(
  Config.defaultLayer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  AppFileSystem.defaultLayer,
  RuntimeFlags.defaultLayer,
  ProcessManager.defaultLayer,
)

const it = testEffect(baseLayer)

// Helper: produce a `ReadableStream<Uint8Array>` from a list of
// byte arrays. We split on byte boundaries that correspond to
// real-world streaming output (e.g. the kernel may deliver "こ"
// (E3 81 93) as two writes: E3 81 then 93).
function chunkedReadable(chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[i]!)
      i++
    },
  })
}

// Helper: same idea for Effect `Stream<Uint8Array>`.
function chunkedEffectStream(chunks: ReadonlyArray<Uint8Array>): Stream.Stream<Uint8Array, never, never> {
  return Stream.fromIterable(chunks)
}

// Decode every captured event through a fresh TextDecoder so the
// test does not depend on how the manager stores events. This is
// what the LLM-facing JSON path effectively does.
async function decodeAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) buf += decoder.decode(value, { stream: true })
    }
    buf += decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
  return buf
}

describe("ProcessManager drainStream UTF-8 chunk-boundary decoding", () => {
  it.instance(
    "ReadableStream: Japanese text split across chunk boundaries decodes correctly",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        // "こんにちは" = E3 81 93 E3 82 93 E3 81 AB E3 81 A1 E3 81 AF
        const hello = new TextEncoder().encode("こんにちは")
        // Split the byte stream at arbitrary, possibly multi-byte,
        // boundaries to force the drain to re-assemble sequences
        // that span chunks.
        const splitAt = [1, 3, 5, 7] // arbitrary split points
        const chunks: Uint8Array[] = []
        let cursor = 0
        for (const at of splitAt) {
          chunks.push(hello.subarray(cursor, Math.min(at, hello.length)))
          cursor = Math.min(at, hello.length)
        }
        if (cursor < hello.length) chunks.push(hello.subarray(cursor))

        const readable = chunkedReadable(chunks)
        const proc = yield* Effect.sync(() =>
          Bun.spawn(["cmd", "/c", "echo"], { stdout: "pipe", stderr: "pipe" }),
        )
        // We don't actually read proc.stdout; we pass the readable
        // stream directly to the manager so we can control the
        // exact chunk boundaries.
        void proc
        const info = yield* manager.promote({
          sessionID: "ses_utf8_rs",
          command: "utf8-stream-test",
          cwd: "/",
          pid: 7001,
          stdinAvailable: false,
          child: {
            pid: 7001,
            exitCode: Effect.succeed(0),
            kill: () => {},
          },
          stdout: readable,
        })

        // Poll until the buffer holds the full Japanese phrase or
        // 2 seconds elapse.
        let observed = ""
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          const polled = yield* manager.poll({
            sessionID: "ses_utf8_rs",
            handle: info.handle as ProcessHandle,
            cursor: 0,
          })
          if (polled) observed = polled.events.map((e) => e.text).join("")
          if (observed === "こんにちは") break
          yield* Effect.sleep("20 millis")
        }
        // The drain path uses ONE TextDecoder across all chunks, so
        // multi-byte sequences that span chunk boundaries reassemble
        // into the original text. The expected value is exactly
        // "こんにちは" — no U+FFFD replacement, no mangled prefix.
        expect(observed).toBe("こんにちは")
      }),
  )

  it.instance(
    "Effect Stream: Japanese text split across chunk boundaries decodes correctly",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        const hello = new TextEncoder().encode("こんにちは")
        const splitAt = [2, 4, 6, 8]
        const chunks: Uint8Array[] = []
        let cursor = 0
        for (const at of splitAt) {
          chunks.push(hello.subarray(cursor, Math.min(at, hello.length)))
          cursor = Math.min(at, hello.length)
        }
        if (cursor < hello.length) chunks.push(hello.subarray(cursor))

        const stream = chunkedEffectStream(chunks)
        const info = yield* manager.promote({
          sessionID: "ses_utf8_es",
          command: "utf8-effect-stream-test",
          cwd: "/",
          pid: 7002,
          stdinAvailable: false,
          child: {
            pid: 7002,
            exitCode: Effect.succeed(0),
            kill: () => {},
          },
          stdout: stream,
        })
        let observed = ""
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          const polled = yield* manager.poll({
            sessionID: "ses_utf8_es",
            handle: info.handle as ProcessHandle,
            cursor: 0,
          })
          if (polled) observed = polled.events.map((e) => e.text).join("")
          if (observed === "こんにちは") break
          yield* Effect.sleep("20 millis")
        }
        expect(observed).toBe("こんにちは")
      }),
  )

  it.instance("ReadableStream: 4-byte emoji sequence split mid-codepoint decodes correctly", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // "😀" (U+1F600) = F0 9F 98 80 — 4 bytes, all of which must
      // reach the decoder together OR arrive in a sequence of
      // stream-mode decodes that the decoder can buffer.
      const emoji = new TextEncoder().encode("😀😀😀")
      const chunks: Uint8Array[] = [
        emoji.subarray(0, 3), // F0 9F 98 — split mid-codepoint
        emoji.subarray(3, 7), // 80 + next F0 9F
        emoji.subarray(7), // 98 80
      ]
      const readable = chunkedReadable(chunks)
      const info = yield* manager.promote({
        sessionID: "ses_utf8_emoji",
        command: "emoji",
        cwd: "/",
        pid: 7003,
        stdinAvailable: false,
        child: {
          pid: 7003,
          exitCode: Effect.succeed(0),
          kill: () => {},
        },
        stdout: readable,
      })
      let observed = ""
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const polled = yield* manager.poll({
          sessionID: "ses_utf8_emoji",
          handle: info.handle as ProcessHandle,
          cursor: 0,
        })
        if (polled) observed = polled.events.map((e) => e.text).join("")
        if (observed === "😀😀😀") break
        yield* Effect.sleep("20 millis")
      }
      expect(observed).toBe("😀😀😀")
    }),
  )

  it.instance("Stream end-of-stream flushes partial multi-byte sequences", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // "あ" = E3 81 82 — 3 bytes. Send the first 2 bytes then
      // close the stream. The decoder's end-of-stream flush must
      // emit the partial sequence as U+FFFD rather than silently
      // dropping it. We assert either the full character (if
      // the decoder's buffering completes it) OR the replacement
      // char; in either case the buffer is non-empty after the
      // stream closes (the bytes are not lost).
      const partial = new Uint8Array([0xe3, 0x81])
      const readable = chunkedReadable([partial])
      const info = yield* manager.promote({
        sessionID: "ses_utf8_partial",
        command: "partial",
        cwd: "/",
        pid: 7004,
        stdinAvailable: false,
        child: {
          pid: 7004,
          exitCode: Effect.succeed(0),
          kill: () => {},
        },
        stdout: readable,
      })
      let observed = ""
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const polled = yield* manager.poll({
          sessionID: "ses_utf8_partial",
          handle: info.handle as ProcessHandle,
          cursor: 0,
        })
        if (polled) observed = polled.events.map((e) => e.text).join("")
        if (observed.length > 0) break
        yield* Effect.sleep("20 millis")
      }
      // The decoder emits the partial bytes as U+FFFD when flushed.
      // We accept either:
      //   - "あ" (if the underlying TextDecoder implementation
      //     buffers across the end-of-stream and synthesizes the
      //     missing byte)
      //   - "\uFFFD" (the standard replacement behavior)
      // Either way, the buffer MUST have something — the bytes are
      // not silently dropped.
      expect(observed.length).toBeGreaterThan(0)
      expect(observed === "あ" || observed === "\uFFFD").toBe(true)
    }),
  )
})

// Async helper exported for the harness above. Not part of the
// test surface; just kept here for clarity.
void decodeAll
