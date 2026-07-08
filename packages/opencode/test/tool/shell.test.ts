import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "../../src/shell/shell"
import { ShellTool, STABLE_SHELL_ENV_OVERRIDES, mergeShellEnv } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProcessManager } from "@/process-manager"
import { ProcessHandle } from "@/process-manager/id"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  ProcessManager.defaultLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const nodeTestBin = Bun.which("node")
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const lineMarker = (index: number) => `LINE-${String(index).padStart(6, "0")}`
const markerLines = (count: number) => Array.from({ length: count }, (_, i) => lineMarker(i + 1))
const markerOutput = (count: number) => markerLines(count).join("\n") + "\n"
const fillMarkers = (count: number) => {
  const code =
    "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>String.fromCharCode(76,73,78,69,45)+String(i+1).padStart(6,String.fromCharCode(48))).join(String.fromCharCode(10)))"
  const text = `${bin} -e ${evalarg(code)} ${count}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const parseLineMarkers = (text: string) => text.split(/\r?\n/).filter((line) => /^LINE-\d{6}$/.test(line))
const stripAnsi = (text: string) => text.replace(/\u001B\[[0-9;]*m/g, "")
const expectExactMarkers = (text: string, count: number) => {
  const expected = markerLines(count)
  const actual = parseLineMarkers(text)
  const duplicates = actual.filter((line, i) => actual.indexOf(line) !== i)
  const missing = expected.filter((line) => !actual.includes(line))
  expect(actual.length).toBe(count)
  expect(duplicates).toEqual([])
  expect(missing).toEqual([])
  expect(actual).toEqual(expected)
}
const nodeEval = (code: string) => {
  const text = `${bin} -e ${evalarg(code)}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
// Marker-then-stay-alive helper for abort/timeout tests. The bash chain
// `echo X && sleep N` is racy on Windows: the chain runs in two separate
// child processes, the first can be reaped before stdout drains, and bash
// startup plus the 2000ms Windows floor can push "started" past the 500ms
// foreground timeout. A single Node process that writes the marker
// (with trailing newline so libuv flushes the pipe buffer) and then parks
// itself on a long-lived setInterval deterministically emits the marker
// first and stays alive until the parent kills it via abort/timeout.
const writesAndWaits = (marker: string) =>
  nodeEval(
    `process.stdout.write(${JSON.stringify(marker + "\n")}); setInterval(() => {}, 60000)`,
  )
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const descendantPidFile = "descendant.pid"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

const ignoredKillError = (err: unknown) => {
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined
  return code === "ESRCH" || code === "EINVAL"
}

async function killProcessTree(pid: number | undefined) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).exited.catch(() => undefined)
    await gone(pid, 1_000)
    return
  }

  try {
    process.kill(-pid, "SIGKILL")
  } catch (err) {
    if (ignoredKillError(err)) return
    try {
      process.kill(pid, "SIGKILL")
    } catch (singleErr) {
      if (!ignoredKillError(singleErr)) throw singleErr
    }
  }
  await gone(pid, 1_000)
}

async function cleanupPidFile(file: string) {
  const pid = Number((await fs.readFile(file, "utf8").catch(() => "")).trim())
  if (Number.isFinite(pid)) await killProcessTree(pid)
}

const tmpdirWithPidCleanup = () =>
  Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-shell-stdio-"))),
    (dir) =>
      Effect.promise(async () => {
        await cleanupPidFile(path.join(dir, descendantPidFile))
        await fs.rm(dir, { recursive: true, force: true })
      }),
  )

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
          description: "Echo test message",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
              description: "Echo fallback text",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                    description: "Remove a temp directory",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
              description: "Read wildcard path",
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                    description: "Copy Windows ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                  description: "Read nested PowerShell file",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                    description: "Read home config",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                    description: "Read pshome file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "OPENCODE_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                  description: "Read Windows ini from env",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                    description: "Read Windows ini from FileSystem provider",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                    description: "Read Windows ini from braced env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                  description: "Change location",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                  description: "Write repeated text",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                description: "Read Windows ini with cmd",
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                    description: "Echo from Git Bash tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
                    description: "Read Git Bash tmp file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp, "nested")))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const nested = path.join(tmp, "nested")
          yield* run(
            {
              command: sh() === "cmd" ? `rmdir /s /q ${quote(nested)}` : `rm -rf ${nested}`,
              description: "Remove nested dir",
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const command = sh() === "cmd" ? "dir" : "ls -la"
          yield* run({ command, description: "List" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe(sh() === "cmd" ? "dir *" : "ls *")
        }),
      )
    }),
  )
})

describe("tool.shell background promotion guidance", () => {
  it.live(
    "background-promoted result advertises process tool JSON args",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const manager = yield* ProcessManager.Service
          const command = nodeEval(`setTimeout(() => process.exit(0), 30_000)`)
          const result = yield* run(
            {
              command,
              description: "background guidance",
              timeout: 30_000,
              background_after_ms: 250,
            },
            ctx,
          )
          const metadata = result.metadata as {
            background?: boolean
            processHandle?: string
            pollHint?: string
            stopHint?: string
            listHint?: string
          }
          const handle = result.metadata.processHandle as ProcessHandle
          yield* Effect.sync(() => {
            expect(metadata.background).toBe(true)
            expect(typeof metadata.processHandle).toBe("string")
            expect((metadata.processHandle ?? "").length).toBeGreaterThan(0)
            expect(metadata.pollHint?.startsWith("Use the process tool with ")).toBe(true)
            expect(metadata.stopHint?.startsWith("Use the process tool with ")).toBe(true)
            expect(metadata.listHint?.startsWith("Use the process tool with ")).toBe(true)
            expect(result.output).toContain("Command is still running in the background.")
            expect(result.output).toContain(
              `{"action":"poll","handle":"${handle}","cursor":0,"wait_ms":300000}`,
            )
            expect(result.output).toContain("wait_ms:300000 waits until new output arrives or the command exits")
            expect(result.output).toContain(
              "On each subsequent poll, pass the previous result's next_cursor as cursor.",
            )
            expect(result.output).toContain(
              `Use the process tool with {"action":"stop","handle":"${handle}"} only if you want to terminate it.`,
            )
            expect(result.output).toContain(`If unsure, call the process tool with {"action":"list"} first.`)
            expect(result.output).not.toContain("Use process poll to read output, process stop to terminate.")
            // Background promotion must warn against re-running and
            // explain the timeout/running poll-again contract using the
            // exact required sentences.
            expect(result.output).toContain(
              "Do not re-run the original command just to wait for completion; that starts a second process.",
            )
            expect(result.output).toContain(
              'If a poll returns wait_status:"timeout" with state running, the command is still running; poll again with the returned next_cursor.',
            )
            // Forbidden phrases must not appear in the background guidance.
            expect(result.output).not.toContain("returned result's")
            expect(result.output).not.toContain("same cursor")
            expect(result.output).not.toContain("reaped by the manager")
          }).pipe(Effect.ensuring(manager.stop({ sessionID: ctx.sessionID, handle }).pipe(Effect.ignore)))
        }),
      ),
    45_000,
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: writesAndWaits("before"),
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: writesAndWaits("started"),
            description: "Timeout test",
            timeout: 500,
          })
          expect(result.output).toContain("started")
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
          expect(result.output).toContain("retry with a larger timeout value in milliseconds")
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("falls back to 500ms")
          const result = yield* tool.execute(
            {
              command: writesAndWaits("started"),
              description: "Default timeout test",
            },
            ctx,
          )
          expect(result.output).toContain("started")
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
            description: "Stderr test",
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
          description: "Non-zero exit",
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("surfaces signal exit failure instead of converting it to null", () =>
    process.platform === "win32"
      ? Effect.void
      : runIn(
          projectRoot,
          Effect.gen(function* () {
            const error = yield* fail({
              command: "kill -TERM $$",
              description: "Signal exit",
            })
            expect(error.message).toContain("Process interrupted due to receipt of signal")
            expect(error.message).toContain("SIGTERM")
          }),
        ),
  )

  it.live("spawn ENOENT is not reported as timeout", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const started = Date.now()
      const error = yield* runIn(
        tmp,
        fail({
          command: "echo should-not-run",
          description: "Missing cwd spawn",
          workdir: path.join(tmp, "missing-cwd"),
          timeout: 500,
        }),
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(error.message).not.toContain("shell tool terminated command after exceeding timeout")
      expect(error.message.toLowerCase()).toMatch(/enoent|not found|no such file|cwd/)
    }),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            command: `echo first && sleep 0.1 && echo second`,
            description: "Streaming test",
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
          description: "Generate bytes exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = 3
        const result = yield* run({
          command: fillMarkers(lineCount),
          description: "Generate marker lines",
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect((result.metadata as { outputPath?: string }).outputPath).toBeUndefined()
        expect(result.output).toBe(markerOutput(lineCount))
        expectExactMarkers(result.output, lineCount)
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fillMarkers(lineCount),
          description: "Generate lines for file check",
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* AppFileSystem.Service).readFileString(filepath!)
        expect(saved).toBe(markerOutput(lineCount))
        expectExactMarkers(saved, lineCount)
      }),
    ),
  )

  it.live("full byte output is saved exactly after truncation", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
          description: "Generate bytes for file check",
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* AppFileSystem.Service).readFileString(filepath!)
        expect(saved).toBe("a".repeat(byteCount))
      }),
    ),
  )
})

describe("tool.shell stdio lifecycle regression", () => {
  // Regression for anomalyco/opencode#20902, #24731, #24784, #22012:
  // the shell tool must finalize output when the foreground process exits,
  // not when stdio is finally closed. Descendants may keep stdio open
  // indefinitely; the shell result must not be held hostage.
  it.live(
    "returns in bounded time when detached child holds stdio open",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // Foreground command writes a line, then spawns a detached child
          // that inherits stdio and runs for 10 seconds. The shell tool
          // must return promptly after the foreground exits, and include
          // the foreground's output.
          const tmp = yield* tmpdirWithPidCleanup()
          const pidFile = path.join(tmp, descendantPidFile)
          const helper = `const fs=require("node:fs");console.log("fg-output");const c=require("node:child_process").spawn(${JSON.stringify(
            process.execPath,
          )},["-e","setTimeout(()=>{},10000)"],{detached:true,stdio:"inherit",shell:false,windowsHide:true});fs.writeFileSync(${JSON.stringify(
            pidFile,
          )},String(c.pid));c.unref();process.exit(0)`
          const command = nodeEval(helper)
          const started = Date.now()
          const result = yield* run({ command, description: "Detached child holds stdio" })
          const elapsed = Date.now() - started
          // Foreground exits in well under 5s even though detached child
          // holds stdio for 10s.
          expect(elapsed).toBeLessThan(5_000)
          expect(result.output).toContain("fg-output")
        }),
      ),
    15_000,
  )

  it.live(
    "does not import continuous descendant output after foreground exit",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // Foreground writes a marker, exits. A detached child then keeps
          // writing "noise" to the inherited stdout for 5s. The shell
          // result must contain the marker but NOT be held open for the
          // full 5s, and must not include unbounded noise.
          const marker = "FG-MARKER"
          const noise = "noise-line"
          const tmp = yield* tmpdirWithPidCleanup()
          const pidFile = path.join(tmp, descendantPidFile)
          const inner = `setInterval(() => process.stdout.write(${JSON.stringify(noise + "\n")}), 50)`
          const nodeScript = `const fs=require("node:fs");console.log(${JSON.stringify(
            marker,
          )});const c=require("node:child_process").spawn(${JSON.stringify(process.execPath)},["-e",${JSON.stringify(
            inner,
          )}],{detached:true,stdio:"inherit",shell:false,windowsHide:true});fs.writeFileSync(${JSON.stringify(
            pidFile,
          )},String(c.pid));c.unref();process.exit(0)`
          const command = nodeEval(nodeScript)
          const started = Date.now()
          const result = yield* run({ command, description: "Descendant writes noise" })
          const elapsed = Date.now() - started
          // Foreground exits promptly. We tolerate up to 5s for the capture
          // drain grace window; the detached noise-writer would otherwise
          // hold stdio for much longer.
          expect(elapsed).toBeLessThan(5_000)
          expect(result.output).toContain(marker)
          // We assert that the result did not accumulate an unbounded
          // amount of noise. The capture boundary is the foreground exit,
          // so we expect at most a small amount of noise (the drain grace
          // window). 200 lines of noise is a generous bound; the actual
          // amount is normally a handful.
          const noiseCount = (result.output.match(/noise-line/g) ?? []).length
          expect(noiseCount).toBeLessThan(200)
        }),
      ),
    15_000,
  )

  it.live("preserves foreground output produced before exit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // The foreground process writes a distinctive string, then exits
        // normally. The shell result must contain that string even
        // though there is also a small amount of inherited-stdio data
        // flowing around the exit.
        const result = yield* run({
          command: `echo fg-marker-output`,
          description: "Preserve foreground output",
        })
        expect(result.output).toContain("fg-marker-output")
      }),
    ),
  )

  it.live(
    "fast producer: large output is not lost when metadata callbacks are slow",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // The metadata callback intentionally sleeps. The producer
          // emits many lines. Capture must continue even when metadata
          // is slow: the final output must contain all (or nearly all)
          // foreground lines. We use `fill("lines", lines)` to construct
          // a command that is compatible with all configured shells.
          const lines = 500
          const command = fillMarkers(lines)
          let metadataCalls = 0
          const result = yield* run(
            { command, description: "Fast producer" },
            {
              ...ctx,
              metadata: () =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolve) =>
                      setTimeout(() => {
                        metadataCalls++
                        resolve()
                      }, 5),
                    ),
                ),
            },
          )
          // The capture pipeline is decoupled from metadata so a slow
          // metadata callback cannot back-pressure persistence. Every
          // foreground marker must appear exactly once, in producer order.
          expectExactMarkers(result.output, lines)
          expect(metadataCalls).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "abort returns in bounded time",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const command = writesAndWaits("begin")
          const start = Date.now()
          const result = yield* run(
            { command, description: "Abort timing" },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("begin") && !controller.signal.aborted) {
                    controller.abort()
                  }
                }),
            },
          )
          const elapsed = Date.now() - start
          // Abort must complete in well under the would-be sleep.
          expect(elapsed).toBeLessThan(5_000)
          expect(result.output).toContain("begin")
          expect(result.output).toContain("User aborted the command")
        }),
      ),
    10_000,
  )

  it.live(
    "timeout returns in bounded time",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const start = Date.now()
          const result = yield* run({
            command: writesAndWaits("begun"),
            description: "Timeout timing",
            timeout: 500,
          })
          const elapsed = Date.now() - start
          // Timeout fires at ~500ms; cleanup must complete promptly.
          expect(elapsed).toBeLessThan(5_000)
          expect(result.output).toContain("begun")
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
        }),
      ),
    10_000,
  )
})

// Windows + PowerShell integration regression test.
//
// The original bug surfaced on Windows where a foreground process exits
// but a detached descendant (e.g. conhost, a daemon, a grandchild) holds
// the stdio handles open. We exercise the shell tool end-to-end through
// PowerShell 5.1 and pwsh (if available) to confirm the fix on the exact
// platform where the bug was reported.
//
// The fixture script writes a distinctive marker, spawns a detached child
// that inherits stdio, and exits. The shell tool must return promptly,
// include the marker, and not be held hostage by the detached child's
// open stdio handles.
describe("tool.shell Windows PowerShell integration", () => {
  if (process.platform !== "win32") {
    it.live("skipped on non-Windows", () => Effect.void)
    return
  }

  const allShells = [
    { label: "powershell-5.1", shell: Bun.which("powershell") },
    { label: "pwsh", shell: Bun.which("pwsh") },
  ]

  for (const candidate of allShells) {
    if (!candidate.shell) {
      it.live(`${candidate.label}: skipped because executable is unavailable`, () => Effect.void)
      continue
    }
    const item = { label: candidate.label, shell: candidate.shell }

    it.live(
      `${item.label}: detached child holds stdio but shell returns bounded time with marker`,
      () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              // Build a Node.js script that:
              //  1. Writes a distinctive marker to stdout.
              //  2. Spawns a detached child that inherits stdio and sleeps
              //     for 10 seconds (so stdio stays open long after the
              //     foreground process has exited).
              //  3. Exits.
              const tmp = yield* tmpdirWithPidCleanup()
              const scriptPath = path.join(tmp, "detach-fixture.cjs")
              const pidFile = path.join(tmp, descendantPidFile)
              const fixture = `
                const { spawn } = require("node:child_process")
                const fs = require("node:fs")
                process.stdout.write("PS-MARKER-${item.label}\\n")
                const c = spawn(${JSON.stringify(process.execPath)}, ["-e", "setTimeout(()=>{}, 10000)"], {
                  detached: true,
                  stdio: "inherit",
                  windowsHide: true,
                })
                fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))
                c.unref()
                process.exit(0)
              `
              yield* Effect.promise(() => Bun.write(scriptPath, fixture))
              const start = Date.now()
              const result = yield* run({
                command: `& ${bin} ${quote(scriptPath.replaceAll("\\", "/"))}`,
                description: "PS detach fixture",
              })
              const elapsed = Date.now() - start
              // The shell tool must return well under 10s. The detached
              // child would otherwise hold stdio for the full 10s.
              expect(elapsed).toBeLessThan(5_000)
              // The marker must be present in the output.
              expect(result.output).toContain(`PS-MARKER-${item.label}`)
              // The shell tool must NOT report a timeout (the command
              // finished promptly, only the detached child was slow).
              expect(result.output).not.toContain("shell tool terminated command after exceeding timeout")
              // Exit code must be 0 (the foreground process exited 0).
              expect(result.metadata.exit).toBe(0)
            }),
          ),
        ),
      10_000,
    )

    if (!nodeTestBin) {
      it.live(`${item.label}: skipped node --test pipeline because node executable is unavailable`, () => Effect.void)
      continue
    }

    it.live(
      `${item.label}: runs node --test summary through Select-String pipeline`,
      () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const tmp = yield* tmpdirWithPidCleanup()
              const fixturePath = path.join(tmp, "pipeline-fixture.test.cjs")
              const fixture = `
                const test = require("node:test")
                test("pipeline pass one", () => {})
                test("pipeline pass two", () => {})
              `
              yield* Effect.promise(() => Bun.write(fixturePath, fixture))
              const result = yield* run({
                command: `& ${quote(nodeTestBin.replaceAll("\\", "/"))} --test --test-reporter tap ${quote(
                  fixturePath.replaceAll("\\", "/"),
                )} 2>&1 | Select-String -Pattern "^# (tests|fail|pass|cancelled|skipped)" | Select-Object -First 10`,
                description: "PowerShell node test summary pipeline",
              })
              const lines = stripAnsi(result.output)
                .split(/\r?\n/)
                .map((line) => line.trim())
              expect(result.metadata.exit).toBe(0)
              expect(lines).toContain("# tests 2")
              expect(lines).toContain("# pass 2")
              expect(lines).toContain("# fail 0")
              expect(lines).toContain("# cancelled 0")
              expect(lines).toContain("# skipped 0")
              expect(result.output).not.toContain("shell tool terminated command after exceeding timeout")
            }),
          ),
        ),
      10_000,
    )
  }
})

describe("STABLE_SHELL_ENV_OVERRIDES", () => {
  test("contains exactly the documented Codex-compatible keys", () => {
    expect(Object.keys(STABLE_SHELL_ENV_OVERRIDES).sort()).toEqual(
      [
        "COLORTERM",
        "CODEX_CI",
        "GH_PAGER",
        "GIT_PAGER",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "NO_COLOR",
        "PAGER",
        "TERM",
      ].sort(),
    )
  })

  test("does not include the unstable CI variable", () => {
    expect(STABLE_SHELL_ENV_OVERRIDES).not.toHaveProperty("CI")
  })

  test("sets COLORTERM to the empty string", () => {
    expect(STABLE_SHELL_ENV_OVERRIDES.COLORTERM).toBe("")
  })
})

describe("mergeShellEnv", () => {
  test("applies base, then stable overrides, then caller overrides (in that order)", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    }
    const overrides: NodeJS.ProcessEnv = {
      PATH: "/custom/bin",
      COLORTERM: "truecolor",
    }
    const result = mergeShellEnv(base, overrides)
    // Stable overrides win over base.
    expect(result.TERM).toBe(STABLE_SHELL_ENV_OVERRIDES.TERM)
    expect(result.LANG).toBe(STABLE_SHELL_ENV_OVERRIDES.LANG)
    expect(result.NO_COLOR).toBe(STABLE_SHELL_ENV_OVERRIDES.NO_COLOR)
    expect(result.PAGER).toBe(STABLE_SHELL_ENV_OVERRIDES.PAGER)
    expect(result.GIT_PAGER).toBe(STABLE_SHELL_ENV_OVERRIDES.GIT_PAGER)
    expect(result.GH_PAGER).toBe(STABLE_SHELL_ENV_OVERRIDES.GH_PAGER)
    expect(result.CODEX_CI).toBe(STABLE_SHELL_ENV_OVERRIDES.CODEX_CI)
    expect(result.LC_CTYPE).toBe(STABLE_SHELL_ENV_OVERRIDES.LC_CTYPE)
    expect(result.LC_ALL).toBe(STABLE_SHELL_ENV_OVERRIDES.LC_ALL)
    // Caller overrides win last, including over stable overrides.
    expect(result.COLORTERM).toBe("truecolor")
    // Caller overrides win over base.
    expect(result.PATH).toBe("/custom/bin")
    // Base keys not touched by overrides or stable values pass through.
    expect(result.HOME).toBe("/home/x")
  })

  test("does not mutate the inputs", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", TERM: "xterm" }
    const overrides: NodeJS.ProcessEnv = { PATH: "/custom/bin" }
    const baseSnapshot = { ...base }
    const overrideSnapshot = { ...overrides }
    mergeShellEnv(base, overrides)
    expect(base).toEqual(baseSnapshot)
    expect(overrides).toEqual(overrideSnapshot)
  })

  test("returns an object that has every stable override key", () => {
    const result = mergeShellEnv({}, {})
    const overrides = STABLE_SHELL_ENV_OVERRIDES as Readonly<Record<string, string>>
    for (const key of Object.keys(overrides)) {
      expect(result[key]).toBe(overrides[key])
    }
  })
})

describe("tool.shell stable env integration", () => {
  it.live("emits the stable env vars to the child process", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // The child writes a JSON object containing the env vars we
        // care about. We can't pre-set those vars in the parent
        // (we want to see what the tool resolves them to) so we
        // rely on the stable overrides to be present.
        //
        // COLORTERM is intentionally NOT validated here because on
        // Windows hosts the bash/PowerShell child inherits a
        // non-empty COLORTERM (e.g. via mintty) through the spawner
        // even though mergeShellEnv collapsed the tool-supplied
        // value to "". The "" contract is asserted at the unit-test
        // level (see the STABLE_SHELL_ENV_OVERRIDES describe block);
        // this live test only checks the non-empty-coded stable keys.
        const code = [
          "const out = {",
          "  NO_COLOR: process.env.NO_COLOR,",
          "  TERM: process.env.TERM,",
          "  LANG: process.env.LANG,",
          "  LC_CTYPE: process.env.LC_CTYPE,",
          "  LC_ALL: process.env.LC_ALL,",
          "  PAGER: process.env.PAGER,",
          "  GIT_PAGER: process.env.GIT_PAGER,",
          "  GH_PAGER: process.env.GH_PAGER,",
          "  CODEX_CI: process.env.CODEX_CI,",
          "};",
          "process.stdout.write(JSON.stringify(out));",
        ].join("\n")
        const command = nodeEval(code)
        const result = yield* run({
          command,
          description: "Inspect stable env vars",
        })
        const parsed = JSON.parse(result.output.trim()) as Record<string, string | undefined>
        expect(parsed.NO_COLOR).toBe(STABLE_SHELL_ENV_OVERRIDES.NO_COLOR)
        expect(parsed.TERM).toBe(STABLE_SHELL_ENV_OVERRIDES.TERM)
        expect(parsed.LANG).toBe(STABLE_SHELL_ENV_OVERRIDES.LANG)
        expect(parsed.LC_CTYPE).toBe(STABLE_SHELL_ENV_OVERRIDES.LC_CTYPE)
        expect(parsed.LC_ALL).toBe(STABLE_SHELL_ENV_OVERRIDES.LC_ALL)
        expect(parsed.PAGER).toBe(STABLE_SHELL_ENV_OVERRIDES.PAGER)
        expect(parsed.GIT_PAGER).toBe(STABLE_SHELL_ENV_OVERRIDES.GIT_PAGER)
        expect(parsed.GH_PAGER).toBe(STABLE_SHELL_ENV_OVERRIDES.GH_PAGER)
        expect(parsed.CODEX_CI).toBe(STABLE_SHELL_ENV_OVERRIDES.CODEX_CI)
      }),
    ),
  )
})

describe("tool.shell description advertises background-process-handle usage", () => {
  it.instance("description includes the background-process-handle usage bullet", () =>
    Effect.gen(function* () {
      const def = yield* (yield* ShellTool).init()
      // The bullet sits between the background_after_ms bullet and the
      // "clear, concise description" bullet, and must be present in
      // every rendered shell (bash, powershell, cmd). The host shell
      // determines which profile renders, so we only assert on text
      // that is identical across all three profiles.
      expect(def.description).toContain("When a command returns a background process handle")
      expect(def.description).toContain("do NOT run the same command again to wait for it")
      expect(def.description).toContain(
        '{"action":"poll","handle":"<handle>","cursor":0,"wait_ms":300000}',
      )
      expect(def.description).toContain("pass the returned next_cursor on subsequent polls")
      expect(def.description).toContain('wait_status "timeout"')
      expect(def.description).toContain('info.state "running"')
      expect(def.description).toContain("stop it only if you intend to terminate it")
      expect(def.description).toContain("wait_status")
      expect(def.description).toContain("next_cursor")
      // Forbidden phrases must not appear in the description.
      expect(def.description).not.toContain("When the shell returns")
      expect(def.description).not.toContain("returned result's")
      expect(def.description).not.toContain("with state running")
      expect(def.description).not.toContain("Use `stop` only if you intend to terminate it")
      expect(def.description).not.toContain("same cursor")
      expect(def.description).not.toContain("reaped by the manager")
    }),
  )
})
