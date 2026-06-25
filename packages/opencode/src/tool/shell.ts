import { Effect, Exit, Fiber, Queue, Ref, Scope, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters, DEFAULT_BACKGROUND_AFTER_MS } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { ProcessManager } from "@/process-manager"
import { ProcessError, ProcessInfo } from "@/process-manager/types"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// Unified metadata shape for ShellTool. The run() function has multiple
// return paths (foreground / background-promoted / promotion-failed); each
// produces a slightly different literal metadata. We pin the inferred
// `Result` type parameter of Tool.define to this shape so the TUI's
// `Tool.InferMetadata<typeof ShellTool>` returns the union rather than `{}`.
type ShellMetadata = {
  output: string
  description: string
  exit?: number | null
  truncated?: boolean
  outputPath?: string
  background?: boolean
  error?: string
  processHandle?: string
  state?: string
  command?: string
  cwd?: string
  captured?: number
  pollHint?: string
  stopHint?: string
  listHint?: string
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    // Capture the process manager at init time so the execute body doesn't
    // need to `yield* ProcessManager.Service` directly (the tool definition's
    // execute signature requires R=never). The captured reference is used
    // by the background-promotion arm of the run() race.
    const manager = yield* ProcessManager.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
        sessionID: string
        backgroundAfterMs: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      // Promoted flag. When the background timer wins the race, we flip this
      // to true before stopping the local capture/persist/metadata fibers and
      // returning the background result. Every foreground-side cleanup path
      // (closeSink finalizer, captureFiber finalizer, Aborted/TimedOut kill,
      // capture drain, persist sentinel) checks this and becomes a no-op
      // once the manager has taken ownership of the live child.
      const promoted = yield* Ref.make(false)
      const isPromoted = Effect.fnUntraced(function* () {
        return yield* Ref.get(promoted)
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      type Completion =
        | { readonly _tag: "Exited"; readonly exit: Exit.Exit<number, unknown> }
        | { readonly _tag: "Aborted" }
        | { readonly _tag: "TimedOut" }
        | { readonly _tag: "Backgrounded" }

      const { code, completion, override }: {
        code: number | null
        completion: Completion
        override?: {
          readonly title: string
          readonly output: string
          readonly metadata: Record<string, unknown>
        }
      } = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer((_exit) =>
            Effect.gen(function* () {
              if (yield* isPromoted()) return
              yield* closeSink()
            }),
          )
          // Spawn the child in a long-lived scope we own until promote
          // (success or failure). The spawner's `Effect.acquireRelease`
          // finalizer is registered in the scope provided via
          // `Effect.provideService(Scope, longScope)`. We must NOT use
          // `Effect.scoped` here: it would close the scope when the
          // body returns, firing the spawner's finalizer and killing the
          // child. Instead we keep the scope alive across the foreground
          // race so the Backgrounded arm's `manager.promote(...)` can
          // hand the child over to the manager before the scope tears
          // down.
          //
          // Ownership transfer (was: leak the scope; is: hand the scope
          // to the manager):
          //
          // - On successful promote, we pass `release` derived from
          //   `Scope.close(longScope, Exit.void)` to the manager. The
          //   manager calls it exactly once on the first terminal
          //   transition via `finalizeRecord` (natural exit, hard
          //   timeout, stop, killAll*, InstanceState teardown).
          // - On promote failure (LimitReached, etc.), we close the
          //   scope HERE before returning, so the spawner's finalizer
          //   runs and the child is killed cleanly. The `promoted` ref
          //   is left false so the run's normal foreground finalizers
          //   still fire (closeSink).
          // - On the non-backgrounded (foreground / Aborted / TimedOut)
          //   arms, the scope stays in scope-local ownership and is
          //   closed by the Effect.scoped that wraps this whole block
          //   when the body returns. That's fine: the foreground path
          //   is fully done and killing the child is correct.
          const longScope = yield* Scope.make()
          // Scope.close returns an Effect that runs all acquireRelease
          // finalizers attached to `longScope`. The manager invokes the
          // same Effect once via the `release` field on PromoteInput.
          const longScopeRelease = Scope.close(longScope, Exit.void)
          const handle = yield* spawner
            .spawn(cmd(input.shell, input.command, input.cwd, input.env))
            .pipe(Effect.provideService(Scope.Scope, longScope))

          // Output pipeline:
          //
          // 1. Capture: a producer fiber reads `handle.all` (decoded as text)
          //    and offers chunks into a bounded queue. The capture stage
          //    MUST NOT block on stdio EOF; on Windows or when detached
          //    descendants inherit the stdio handles, `close` can lag the
          //    foreground `exit` event indefinitely.
          //
          // 2. Persistence: a consumer fiber drains the queue, applies
          //    truncation/file/output rules. The consumer ends only when it
          //    receives a sentinel "done" chunk. Metadata is published on a
          //    separate queue so a slow metadata callback cannot back-pressure
          //    persistence.
          //
          // 3. Metadata: a third fiber drains the metadata queue and calls
          //    `ctx.metadata`. It is decoupled from capture and persistence.
          //
          // 4. Foreground exit (or Aborted / TimedOut) is the capture
          //    boundary: we interrupt the capture fiber and offer a "done"
          //    sentinel so the persistence consumer drains already-accepted
          //    chunks and stops. Output produced by detached descendants
          //    after the foreground process has exited is NOT pulled into
          //    this Shell result.
          const CAPACITY = 256
          type ChunkEnvelope = { readonly _tag: "chunk"; readonly text: string } | { readonly _tag: "done" }
          const chunks = yield* Queue.bounded<ChunkEnvelope>(CAPACITY)
          const meta = yield* Queue.bounded<{ output: string }>(CAPACITY)
          let captureOpen = true
          const closeCapture = Effect.sync(() => {
            captureOpen = false
          })
          const offerCaptured = (text: string) =>
            Effect.gen(function* () {
              while (true) {
                const offered = yield* Effect.sync(() => {
                  if (!captureOpen) return true
                  return Queue.offerUnsafe(chunks, { _tag: "chunk", text })
                })
                if (offered) return
                yield* Effect.yieldNow
              }
            })
          const offerDone = Effect.gen(function* () {
            while (true) {
              if (yield* Effect.sync(() => Queue.offerUnsafe(chunks, { _tag: "done" }))) return
              yield* Effect.yieldNow
            }
          })

          // Persistence fiber: read from chunks queue, write to disk / list.
          const persist = yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                const item = yield* Queue.take(chunks)
                if (item._tag === "done") {
                  return
                }
                const chunk = item.text
                const size = Buffer.byteLength(chunk, "utf-8")
                list.push({ text: chunk, size })
                used += size
                while (used > keep && list.length > 1) {
                  const first = list.shift()
                  if (!first) break
                  used -= first.size
                  cut = true
                }

                last = preview(last + chunk)

                if (file) {
                  sink?.write(chunk)
                } else {
                  full += chunk
                  if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                    const next = yield* trunc.write(full)
                    file = next
                    cut = true
                    sink = createWriteStream(next, { flags: "a" })
                    full = ""
                  }
                }
                // Publish a metadata update. We do NOT block on the metadata
                // queue; if it is saturated, we drop the update. `last`
                // remains the source of truth for the latest preview.
                Queue.offerUnsafe(meta, { output: last })
              }
            }),
          )

          // Metadata fiber: take metadata updates and call `ctx.metadata`.
          // We bound how many metadata updates we will issue to avoid
          // producing an unbounded stream of events for fast producers.
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                const item = yield* Queue.take(meta)
                yield* ctx.metadata({
                  metadata: {
                    output: item.output,
                    description: input.description,
                  },
                })
              }
            }),
          )

          // Capture fiber: read `handle.all`, offer chunks. We fork and then
          // interrupt this fiber once the foreground process exits (or abort/
          // timeout fires), so we do not keep reading from a stdio handle
          // held open by a detached descendant.
          const captureFiber = Effect.runFork(
            Stream.runForEach(Stream.decodeText(handle.all), offerCaptured).pipe(Effect.ignore),
          )
          yield* Effect.addFinalizer((_exit) =>
            Effect.gen(function* () {
              if (yield* isPromoted()) return
              yield* closeCapture
              yield* Effect.sync(() => captureFiber.interruptUnsafe())
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          // Background promotion timer. Fires after `input.backgroundAfterMs`
          // (0 disables). When it wins the race AND the foreground process
          // is still alive, we promote the live child to the process manager
          // and return a background handle. The captured `handle` is closed
          // over so the manager takes ownership of the spawner's streams.
          const backgroundTimer =
            input.backgroundAfterMs > 0
              ? Effect.as(Effect.sleep(`${input.backgroundAfterMs} millis`), {
                  _tag: "Backgrounded" as const,
                })
              : Effect.never

          // Race foreground exit, abort, timeout, and (optionally) background
          // promotion. The capture boundary is whichever of these resolves
          // first. We use `Effect.exit` to convert a spawn failure (e.g.
          // ENOENT) into a value so the race resolves immediately instead of
          // waiting for the timeout — a failed spawn IS an exit, and we
          // should not wait the full timeout just because the process could
          // not start.
          const completion: Completion = yield* Effect.raceAll([
            Effect.map(Effect.exit(handle.exitCode), (exit) => ({ _tag: "Exited" as const, exit })),
            Effect.map(abort, () => ({ _tag: "Aborted" as const })),
            Effect.map(timeout, () => ({ _tag: "TimedOut" as const })),
            backgroundTimer,
          ])

          // Foreground exit (or abort/timeout) reached. Abort/timeout kill
          // the process group with a bounded wait. A normal foreground exit
          // deliberately does not kill descendants, so we race the capture
          // fiber's natural completion against a short grace window in case
          // stdio is still held open by a detached descendant.
          if (completion._tag === "Aborted") {
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (completion._tag === "TimedOut") {
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          // Backgrounded: the foreground command is still alive when the
          // background timer fired. Hand ownership to the process manager,
          // stop the local capture/persist fibers, and return a background
          // handle so the model can poll/stop it. The `promoted` ref is
          // flipped BEFORE we close the local pipeline so finalizers and
          // kill paths become no-ops for this run.
          if (completion._tag === "Backgrounded") {
            // Stop the local capture pipeline deterministically BEFORE
            // we compute the pre-promote snapshot:
            //
            // 1. Close the capture gate so no new chunks get offered into
            //    the bounded queue.
            // 2. Interrupt the capture fiber so it stops pulling more
            //    chunks from the spawner's merged stream. Any chunks it
            //    has already pushed into the queue are safe.
            // 3. Send the "done" sentinel and join persistence so the
            //    queue drains through to `list` BEFORE we snapshot.
            //
            // We deliberately do NOT race `offerDone` vs `Fiber.join(persist)`;
            // we always wait for persistence to finish so the pre-promote
            // snapshot is the complete foreground view.
            yield* closeCapture
            yield* Effect.sync(() => captureFiber.interruptUnsafe())
            yield* offerDone
            yield* Fiber.join(persist)

            // Pre-promote output snapshot. With persistence fully drained,
            // `list` is the canonical pre-promote text in arrival order.
            // We pass it to the manager via `prePromoteOutput` so the
            // ring buffer reflects what the foreground saw BEFORE the
            // manager takes over stdout/stderr drains. The first `process
            // poll` after promote returns this snapshot as events with
            // seq starting at 1; subsequent post-promote chunks append at
            // higher seqs.
            const prePromoteStdout = list.map((item) => item.text).join("")
            const prePromoteSnapshot = last || (full ? preview(full) : "")

            // Promote may fail with LimitReached (global cap) or another
            // domain error. On failure we close
            // `longScope` ourselves (the manager has already killed the
            // child via `adapter.stop` in the failed promote() call) so
            // the spawner's acquireRelease finalizers run and the child
            // is fully cleaned up. The `promoted` ref is left false so
            // the run's normal foreground finalizers still fire.
            const promotedResult: ProcessInfo | ProcessError = yield* Effect.gen(function* () {
              const exit = yield* Effect.exit(
                manager.promote({
                  sessionID: input.sessionID,
                  command: input.command,
                  cwd: input.cwd,
                  pid: handle.pid,
                  stdinAvailable: false,
                  child: {
                    pid: handle.pid,
                    exitCode: Effect.exit(handle.exitCode).pipe(Effect.map(Number), Effect.orElseSucceed(() => -1)),
                    kill: (sig?: NodeJS.Signals) => {
                      Effect.runFork(
                        handle.kill(sig ? { killSignal: sig } : {}).pipe(Effect.ignore),
                      )
                    },
                  },
                  // `background_after_ms` is opencode's compatibility name
                  // for a Codex-style yield threshold. Once the command has
                  // yielded into the process manager, elapsed time alone must
                  // not become a hard kill deadline.
                  timeoutMs: null,
                  stdout: handle.stdout,
                  stderr: handle.stderr,
                  release: longScopeRelease,
                  prePromoteOutput:
                    prePromoteStdout.length > 0
                      ? { stdout: prePromoteStdout, stderr: "" }
                      : null,
                }),
              )
              if (Exit.isSuccess(exit)) return exit.value
              const cause = exit.cause as unknown as {
                reasons?: ReadonlyArray<{ _tag?: string; error?: unknown }>
              }
              const firstFail = cause.reasons?.find((r) => r._tag === "Fail")
              const err = firstFail?.error as ProcessError | undefined
              if (err && "reason" in err) return err
              return {
                reason: "Internal",
                message: "promote failed",
              } as ProcessError
            })

            const promotedInfo = "state" in promotedResult ? promotedResult : undefined
            const promotedError = "reason" in promotedResult ? promotedResult : undefined

            // Promote failure path: close `longScope` ourselves so the
            // spawner's acquireRelease finalizers run.
            if (promotedError) {
              yield* longScopeRelease.pipe(Effect.ignore)
              const reason = promotedError.reason
              const failureOutput =
                `Command exceeded the background promotion guard (${reason}). ` +
                `The child was terminated. Try a shorter timeout or ` +
                `a smaller ` +
                `background_after_ms. ` +
                `Partial output captured: ${prePromoteSnapshot || "(none)"}`
              return {
                code: null,
                completion,
                override: {
                  title: input.description,
                  output: failureOutput,
                  metadata: {
                    output: prePromoteSnapshot || "(no output)",
                    description: input.description,
                    background: false,
                    error: reason,
                    command: input.command,
                    cwd: input.cwd,
                    captured: Buffer.byteLength(prePromoteSnapshot, "utf-8"),
                  },
                },
              } as const
            }

            if (!promotedInfo) {
              yield* longScopeRelease.pipe(Effect.ignore)
              return yield* Effect.die(new Error("promote returned neither info nor error"))
            }

            yield* Ref.set(promoted, true)

            const info = promotedInfo
            const processPollArgs = JSON.stringify({ action: "poll", handle: info.handle, cursor: 0 })
            const processStopArgs = JSON.stringify({ action: "stop", handle: info.handle })
            const processListArgs = JSON.stringify({ action: "list" })
            const outputText =
              `Command is still running in the background.\n` +
              `Handle: ${info.handle}\n` +
              `State: ${info.state}\n` +
              `Use the process tool with ${processPollArgs} to read output.\n` +
              `Use the process tool with ${processStopArgs} to terminate it.\n` +
              `If unsure, call the process tool with ${processListArgs} first.`
            const metadataOut = prePromoteSnapshot || "(no output yet)"
            yield* ctx
              .metadata({
                metadata: {
                  output: metadataOut,
                  description: input.description,
                  background: true,
                  processHandle: info.handle,
                  state: info.state,
                  command: input.command,
                  cwd: input.cwd,
                  captured: Buffer.byteLength(metadataOut, "utf-8"),
                  pollHint: `Use the process tool with ${processPollArgs}`,
                  stopHint: `Use the process tool with ${processStopArgs}`,
                  listHint: `Use the process tool with ${processListArgs}`,
                },
              })
              .pipe(Effect.ignore)

            return {
              code: null,
              completion,
              override: {
                title: input.description,
                output: outputText,
                metadata: {
                  output: metadataOut,
                  description: input.description,
                  background: true,
                  processHandle: info.handle,
                  state: info.state,
                  command: input.command,
                  cwd: input.cwd,
                  captured: Buffer.byteLength(metadataOut, "utf-8"),
                  pollHint: `Use the process tool with ${processPollArgs}`,
                  stopHint: `Use the process tool with ${processStopArgs}`,
                  listHint: `Use the process tool with ${processListArgs}`,
                },
              },
            } as const
          }

          // Drain the capture fiber when possible, then stop waiting at the
          // foreground boundary. `interruptUnsafe()` is intentionally
          // fire-and-forget: awaiting interruption can itself wait for stdio
          // close in Node stream finalizers.
          const CAPTURE_DRAIN_GRACE_MS = 500
          const captured = yield* Effect.race(
            Fiber.join(captureFiber).pipe(Effect.as(true)),
            Effect.as(Effect.sleep(`${CAPTURE_DRAIN_GRACE_MS} millis`), false),
          )
          yield* closeCapture
          if (!captured) yield* Effect.sync(() => captureFiber.interruptUnsafe())
          // Offer the done sentinel only after the capture gate is closed,
          // so no producer can enqueue after it. Race the offer with
          // persistence failure so a dead consumer cannot deadlock finalization
          // when the bounded queue is full.
          yield* Effect.race(offerDone, Fiber.join(persist))

          // Wait for persistence to finish draining. Bounded by the queue
          // size: persistence ends as soon as it observes the done sentinel.
          yield* Fiber.join(persist)

          // Resolve exit code: the public `handle.exitCode` is now safe to
          // read because foreground process has exited (or we killed it).
          if (completion._tag === "Exited") {
            if (Exit.isFailure(completion.exit)) {
              return yield* Effect.failCause(completion.exit.cause)
            }
            return { code: completion.exit.value, completion }
          }
          return { code: null, completion }
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (override) {
        // Background promotion already produced a fully-formed result. Skip
        // the foreground output formatting — the manager owns capture from
        // here on.
        return override as unknown as Tool.ExecuteResult<ShellMetadata>
      }
      if (completion._tag === "TimedOut") {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (completion._tag === "Aborted") meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        } as ShellMetadata,
        output,
      } as Tool.ExecuteResult<ShellMetadata>
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(
          name,
          process.platform,
          limits,
          defaultTimeoutMs,
          DEFAULT_BACKGROUND_AFTER_MS,
        )
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const backgroundAfterMs =
                params.background_after_ms === undefined ? DEFAULT_BACKGROUND_AFTER_MS : params.background_after_ms
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                  sessionID: ctx.sessionID as unknown as string,
                  backgroundAfterMs,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
