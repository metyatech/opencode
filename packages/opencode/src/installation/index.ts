import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import fs from "fs"
import path from "path"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationBaseVersion, InstallationChannel, InstallationVersion, formatPreviewVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"

const log = Log.create({ service: "installation" })

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "local-fork" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = z
  .object({
    version: z.string(),
    latest: z.string(),
  })
  .meta({
    ref: "InstallationInfo",
  })
export type Info = z.infer<typeof Info>

export const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

function findLocalForkRepo() {
  const configured = process.env.OPENCODE_LOCAL_FORK_REPO
  if (configured && isLocalForkRepo(configured)) return path.resolve(configured)

  let current = path.dirname(process.execPath)
  for (;;) {
    if (isLocalForkRepo(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function isLocalForkRepo(dir: string) {
  return (
    fs.existsSync(path.join(dir, ".git")) &&
    fs.existsSync(path.join(dir, "packages", "opencode", "package.json")) &&
    fs.existsSync(path.join(dir, "packages", "opencode", "script", "build.ts"))
  )
}

function localForkPointerPath(repo: string) {
  return process.env.OPENCODE_LOCAL_FORK_POINTER ?? path.join(repo, "packages", "opencode", ".local-fork-current")
}

function readLocalForkBaseVersion(repo: string) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "packages", "opencode", "package.json"), "utf8")) as {
      version?: unknown
    }
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version
  } catch {}
  return InstallationBaseVersion
}

function localForkVersion(repo: string, branch: string, revision: number, sha: string) {
  return formatPreviewVersion({
    baseVersion: readLocalForkBaseVersion(repo),
    channel: branch,
    revision,
    commit: sha,
    dirty: false,
  })
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const text = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          return out
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed("")),
      )

      const run = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: ChildProcessSpawner.ExitCode(1), stdout: "", stderr: "" })),
      )

      const getBrewFormula = Effect.fnUntraced(function* () {
        const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
        if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
        const coreFormula = yield* text(["brew", "list", "--formula", "opencode"])
        if (coreFormula.includes("opencode")) return "opencode"
        return "opencode"
      })

      const localForkRepo = Effect.fnUntraced(function* () {
        const repo = findLocalForkRepo()
        if (!repo) return
        const origin = (yield* text(["git", "remote", "get-url", "origin"], { cwd: repo })).trim()
        if (!origin.includes("metyatech/opencode") && !origin.includes("metyatech\\opencode")) return
        return repo
      })

      const localForkBranch = Effect.fnUntraced(function* (repo: string) {
        return (yield* text(["git", "branch", "--show-current"], { cwd: repo })).trim() || "dev"
      })

      const upgradeCurl = Effect.fnUntraced(
        function* (target: string) {
          const response = yield* httpOk.execute(HttpClientRequest.get("https://opencode.ai/install"))
          const body = yield* response.text
          const bodyBytes = new TextEncoder().encode(body)
          const proc = ChildProcess.make("bash", [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.orDie,
      )

      const methodImpl = Effect.fn("Installation.method")(function* () {
        if (yield* localForkRepo()) return "local-fork" as Method
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
          { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName =
            check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "opencode" : "opencode-ai"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      })

      const latestImpl = Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* methodImpl())

        if (detectedMethod === "local-fork") {
          const repo = yield* localForkRepo()
          if (!repo) return InstallationVersion
          const branch = yield* localForkBranch(repo)
          const fetch = yield* run(["git", "fetch", "origin", branch], { cwd: repo })
          if (fetch.code !== 0) return InstallationVersion
          const local = (yield* text(["git", "rev-parse", "HEAD"], { cwd: repo })).trim()
          const remote = (yield* text(["git", "rev-parse", `origin/${branch}`], { cwd: repo })).trim()
          if (!remote || remote === local) return InstallationVersion
          const revision = Number.parseInt((yield* text(["git", "rev-list", "--count", `origin/${branch}`], { cwd: repo })).trim(), 10)
          return localForkVersion(repo, branch, Number.isFinite(revision) ? revision : 0, remote)
        }

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get("https://formulae.brew.sh/api/formula/opencode.json").pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              `${yield* NpmConfig.registry(process.cwd())}/opencode-ai/${InstallationChannel}`,
            ).pipe(HttpClientRequest.acceptJson),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
          return data.d.results[0].Version
        }

        if (detectedMethod === "scoop") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
          return data.version
        }

        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://api.github.com/repos/anomalyco/opencode/releases/latest").pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie)

      const upgradeImpl = Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let result: { code: ChildProcessSpawner.ExitCode; stdout: string; stderr: string } | undefined
        switch (m) {
          case "local-fork": {
            const repo = yield* localForkRepo()
            if (!repo) return yield* new UpgradeFailedError({ stderr: "Local metyatech/opencode checkout not found" })
            const status = (yield* text(["git", "status", "--porcelain"], { cwd: repo })).trim()
            if (status) {
              return yield* new UpgradeFailedError({
                stderr:
                  "Local metyatech/opencode checkout has uncommitted changes; commit or stash them before updating",
              })
            }
            const branch = yield* localForkBranch(repo)
            result = yield* run(["git", "pull", "--ff-only", "origin", branch], { cwd: repo })
            if (result.code !== 0) break
            result = yield* run(["bun", "install"], { cwd: repo })
            if (result.code !== 0) break
            const distDir = path.join("dist-local-fork", `${target}-${process.pid}`)
            result = yield* run(
              [
                "bun",
                "run",
                "--cwd",
                "packages/opencode",
                "build",
                "--single",
                "--skip-install",
                "--dist-dir",
                distDir,
              ],
              { cwd: repo },
            )
            if (result.code !== 0) break
            const binary = process.platform === "win32" ? "opencode.exe" : "opencode"
            const built = path.join(
              repo,
              "packages",
              "opencode",
              distDir,
              `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
              "bin",
              binary,
            )
            if (!fs.existsSync(built)) {
              result = {
                code: ChildProcessSpawner.ExitCode(1),
                stdout: result.stdout,
                stderr: `Built local fork binary not found: ${built}`,
              }
              break
            }
            yield* Effect.promise(() => fs.promises.writeFile(localForkPointerPath(repo), built, "utf8"))
            break
          }
          case "curl":
            result = yield* upgradeCurl(target)
            break
          case "npm":
            result = yield* run(["npm", "install", "-g", `opencode-ai@${target}`])
            break
          case "pnpm":
            result = yield* run(["pnpm", "install", "-g", `opencode-ai@${target}`])
            break
          case "bun":
            result = yield* run(["bun", "install", "-g", `opencode-ai@${target}`])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
              if (tap.code !== 0) {
                result = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  result = pull
                  break
                }
              }
            }
            result = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            result = yield* run(["choco", "upgrade", "opencode", `--version=${target}`, "-y"])
            break
          case "scoop":
            result = yield* run(["scoop", "install", `opencode@${target}`])
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown method: ${m}` })
        }
        if (!result || result.code !== 0) {
          const stderr = m === "choco" ? "not running from an elevated command shell" : result?.stderr || ""
          return yield* new UpgradeFailedError({ stderr })
        }
        log.info("upgraded", {
          method: m,
          target,
          stdout: result.stdout,
          stderr: result.stderr,
        })
        yield* text([process.execPath, "--version"])
      })

      return Service.of({
        info: Effect.fn("Installation.info")(function* () {
          return {
            version: InstallationVersion,
            latest: yield* latestImpl(),
          }
        }),
        method: methodImpl,
        latest: latestImpl,
        upgrade: upgradeImpl,
      })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
