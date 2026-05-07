import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import fs from "fs"
import os from "os"
import path from "path"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(handler: (cmd: string, args: readonly string[]) => string = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const output = handler(std?.command ?? "", std?.args ?? [])
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output ? Stream.make(encoder.encode(output)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string,
) {
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(mockSpawner(spawnHandler)))
}

describe("installation", () => {
  describe("latest", () => {
    test("checks the configured local metyatech fork instead of official releases", async () => {
      const previous = process.env.OPENCODE_LOCAL_FORK_REPO
      process.env.OPENCODE_LOCAL_FORK_REPO = path.resolve("../..")
      const calls: string[] = []
      const layer = testLayer(
        (request) => {
          calls.push(request.url)
          return jsonResponse({ tag_name: "v9.9.9" })
        },
        (cmd, args) => {
          calls.push([cmd, ...args].join(" "))
          if (cmd === "git" && args.join(" ") === "remote get-url origin")
            return "https://github.com/metyatech/opencode.git\n"
          if (cmd === "git" && args.join(" ") === "branch --show-current") return "dev\n"
          if (cmd === "git" && args.join(" ") === "rev-parse HEAD") return "1111111111111111111111111111111111111111\n"
          if (cmd === "git" && args.join(" ") === "rev-parse origin/dev")
            return "2222222222222222222222222222222222222222\n"
          return ""
        },
      )

      try {
        const result = await Effect.runPromise(
          Installation.Service.use((svc) => svc.latest("local-fork")).pipe(Effect.provide(layer)),
        )
        expect(result).toBe("0.0.0-fork.222222222222")
        expect(calls.some((call) => call.includes("api.github.com/repos/anomalyco/opencode"))).toBe(false)
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_LOCAL_FORK_REPO
        else process.env.OPENCODE_LOCAL_FORK_REPO = previous
      }
    })

    test("reads release version from GitHub releases", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("unknown")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.2.3")
    })

    test("strips v prefix from GitHub release tag", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v4.0.0-beta.1" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("curl")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("4.0.0-beta.1")
    })

    test("reads npm versions via registry", async () => {
      const calls: string[] = []
      const layer = testLayer((request) => {
        calls.push(request.url)
        return jsonResponse({ version: "1.5.0" })
      })

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("npm")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.5.0")
      expect(calls).toContain(`https://registry.npmjs.org/opencode-ai/${InstallationChannel}`)
    })

    test("reads bun versions via registry", async () => {
      const calls: string[] = []
      const layer = testLayer((request) => {
        calls.push(request.url)
        return jsonResponse({ version: "1.6.0" })
      })

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("bun")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.6.0")
      expect(calls).toContain(`https://registry.npmjs.org/opencode-ai/${InstallationChannel}`)
    })

    test("reads pnpm versions via registry", async () => {
      const calls: string[] = []
      const layer = testLayer((request) => {
        calls.push(request.url)
        return jsonResponse({ version: "1.7.0" })
      })

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("pnpm")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.7.0")
      expect(calls).toContain(`https://registry.npmjs.org/opencode-ai/${InstallationChannel}`)
    })

    test("reads scoop manifest versions", async () => {
      const layer = testLayer(() => jsonResponse({ version: "2.3.4" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("scoop")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.3.4")
    })

    test("reads chocolatey feed versions", async () => {
      const layer = testLayer(() => jsonResponse({ d: { results: [{ Version: "3.4.5" }] } }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("choco")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("3.4.5")
    })

    test("reads brew formulae API versions", async () => {
      const layer = testLayer(
        () => jsonResponse({ versions: { stable: "2.0.0" } }),
        (cmd, args) => {
          // getBrewFormula: return core formula (no tap)
          if (cmd === "brew" && args.includes("--formula") && args.includes("anomalyco/tap/opencode")) return ""
          if (cmd === "brew" && args.includes("--formula") && args.includes("opencode")) return "opencode"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("brew")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.0.0")
    })

    test("reads brew tap info JSON via CLI", async () => {
      const brewInfoJson = JSON.stringify({
        formulae: [{ versions: { stable: "2.1.0" } }],
      })
      const layer = testLayer(
        () => jsonResponse({}), // HTTP not used for tap formula
        (cmd, args) => {
          if (cmd === "brew" && args.includes("anomalyco/tap/opencode") && args.includes("--formula")) return "opencode"
          if (cmd === "brew" && args.includes("--json=v2")) return brewInfoJson
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("brew")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.1.0")
    })
  })

  describe("upgrade", () => {
    test("pulls, builds, and points the launcher at the local metyatech fork", async () => {
      const previousRepo = process.env.OPENCODE_LOCAL_FORK_REPO
      const previousPointer = process.env.OPENCODE_LOCAL_FORK_POINTER
      const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-local-fork-"))
      const target = "0.0.0-fork.222222222222"
      const outputName = `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
      const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode"
      const built = path.join(
        repo,
        "packages",
        "opencode",
        "dist-local-fork",
        `${target}-${process.pid}`,
        outputName,
        "bin",
        binaryName,
      )
      const pointer = path.join(repo, "pointer")
      const calls: string[] = []

      await fs.promises.mkdir(path.join(repo, "packages", "opencode", "script"), { recursive: true })
      await fs.promises.mkdir(path.dirname(built), { recursive: true })
      await fs.promises.writeFile(path.join(repo, ".git"), "gitdir: .git/worktrees/local-fork-test\n")
      await fs.promises.writeFile(path.join(repo, "packages", "opencode", "package.json"), "{}")
      await fs.promises.writeFile(path.join(repo, "packages", "opencode", "script", "build.ts"), "")
      await fs.promises.writeFile(built, "")
      process.env.OPENCODE_LOCAL_FORK_REPO = repo
      process.env.OPENCODE_LOCAL_FORK_POINTER = pointer

      const layer = testLayer(
        () => jsonResponse({ tag_name: "v9.9.9" }),
        (cmd, args) => {
          calls.push([cmd, ...args].join(" "))
          if (cmd === "git" && args.join(" ") === "remote get-url origin")
            return "https://github.com/metyatech/opencode.git\n"
          if (cmd === "git" && args.join(" ") === "branch --show-current") return "dev\n"
          return ""
        },
      )

      try {
        await Effect.runPromise(
          Installation.Service.use((svc) => svc.upgrade("local-fork", target)).pipe(Effect.provide(layer)),
        )
        expect(await fs.promises.readFile(pointer, "utf8")).toBe(built)
        expect(calls).toContain("git pull --ff-only origin dev")
        expect(calls).toContain("bun install")
        expect(calls).toContain(
          ["bun", "run", "--cwd", "packages/opencode", "build", "--single", "--skip-install", "--dist-dir"]
            .concat(path.join("dist-local-fork", `${target}-${process.pid}`))
            .join(" "),
        )
        expect(calls.some((call) => call.includes("install -g opencode-ai"))).toBe(false)
      } finally {
        if (previousRepo === undefined) delete process.env.OPENCODE_LOCAL_FORK_REPO
        else process.env.OPENCODE_LOCAL_FORK_REPO = previousRepo
        if (previousPointer === undefined) delete process.env.OPENCODE_LOCAL_FORK_POINTER
        else process.env.OPENCODE_LOCAL_FORK_POINTER = previousPointer
        await fs.promises.rm(repo, { recursive: true, force: true })
      }
    })
  })
})
