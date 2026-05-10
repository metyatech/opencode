import { $ } from "bun"
import semver from "semver"
import path from "path"
import { createInstallationVersionInfo, formatPreviewVersion } from "../../core/src/installation/version"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]
const opencodePkgPath = path.resolve(import.meta.dir, "../../opencode/package.json")
const opencodePkg = await Bun.file(opencodePkgPath).json()
const baseVersion = opencodePkg.version

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

if (!baseVersion || typeof baseVersion !== "string") {
  throw new Error("version field not found in packages/opencode/package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}
const BRANCH = await $`git branch --show-current`.text().then((x) => x.trim() || "detached")
const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  return BRANCH === "detached" ? "preview" : BRANCH
})()
const IS_PREVIEW = CHANNEL !== "latest"
const COMMIT = await $`git rev-parse HEAD`.text().then((x) => x.trim())
const REVISION = await $`git rev-list --count HEAD`
  .text()
  .then((x) => Number.parseInt(x.trim(), 10))
  .then((x) => (Number.isFinite(x) ? x : 0))
const DIRTY = await $`git status --short --untracked-files=normal`
  .text()
  .then((x) => x.trim().length > 0)
const BUILT_AT = new Date().toISOString()

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  if (IS_PREVIEW) {
    return formatPreviewVersion({
      baseVersion,
      channel: CHANNEL,
      revision: REVISION,
      commit: COMMIT,
      dirty: DIRTY,
    })
  }
  const version = await fetch("https://registry.npmjs.org/opencode-ai/latest")
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.version)
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.OPENCODE_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()
const VERSION_INFO = createInstallationVersionInfo({
  version: VERSION,
  baseVersion,
  channel: CHANNEL,
  branch: BRANCH,
  commit: COMMIT,
  revision: REVISION,
  dirty: DIRTY,
  builtAt: BUILT_AT,
})

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get versionInfo() {
    return VERSION_INFO
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`opencode script`, JSON.stringify(Script, null, 2))
