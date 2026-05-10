export interface PreviewVersionInput {
  baseVersion: string
  channel: string
  revision: number
  commit: string
  dirty?: boolean
}

export interface InstallationVersionInfo {
  version: string
  baseVersion: string
  channel: string
  branch: string
  commit: string
  shortCommit: string
  revision: number | null
  dirty: boolean
  builtAt: string | null
}

const BASE_VERSION_PATTERN = /^\d+\.\d+\.\d+/

export function extractBaseVersion(version: string) {
  return version.match(BASE_VERSION_PATTERN)?.[0] ?? version
}

export function normalizeVersionChannel(channel: string) {
  const normalized = channel
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return normalized || "preview"
}

export function shortCommitSha(commit: string) {
  const trimmed = commit.trim()
  return trimmed ? trimmed.slice(0, 7) : "unknown"
}

export function formatPreviewVersion(input: PreviewVersionInput) {
  const revision = Number.isFinite(input.revision) ? Math.max(0, Math.trunc(input.revision)) : 0
  const metadata = [`sha.${shortCommitSha(input.commit)}`]
  if (input.dirty) metadata.push("dirty")
  return `${input.baseVersion}-${normalizeVersionChannel(input.channel)}.${revision}+${metadata.join(".")}`
}

export function createInstallationVersionInfo(input: {
  version: string
  baseVersion?: string
  channel: string
  branch?: string
  commit?: string
  revision?: number | null
  dirty?: boolean
  builtAt?: string | null
}): InstallationVersionInfo {
  const version = input.version
  const commit = input.commit?.trim() ?? ""
  return {
    version,
    baseVersion: input.baseVersion?.trim() || extractBaseVersion(version),
    channel: input.channel || "local",
    branch: input.branch || input.channel || "local",
    commit,
    shortCommit: shortCommitSha(commit),
    revision: typeof input.revision === "number" && Number.isFinite(input.revision) ? Math.trunc(input.revision) : null,
    dirty: Boolean(input.dirty),
    builtAt: input.builtAt?.trim() || null,
  }
}

export function parseInstallationVersionInfo(raw: string | undefined, fallbackVersion: string, fallbackChannel: string) {
  if (!raw) {
    return createInstallationVersionInfo({
      version: fallbackVersion,
      channel: fallbackChannel,
      branch: fallbackChannel,
    })
  }

  try {
    const parsed = JSON.parse(raw) as Partial<InstallationVersionInfo>
    if (!parsed || typeof parsed !== "object" || typeof parsed.version !== "string") {
      throw new Error("invalid version metadata")
    }
    return createInstallationVersionInfo({
      version: parsed.version,
      baseVersion: typeof parsed.baseVersion === "string" ? parsed.baseVersion : undefined,
      channel: typeof parsed.channel === "string" ? parsed.channel : fallbackChannel,
      branch: typeof parsed.branch === "string" ? parsed.branch : fallbackChannel,
      commit: typeof parsed.commit === "string" ? parsed.commit : undefined,
      revision: typeof parsed.revision === "number" ? parsed.revision : null,
      dirty: Boolean(parsed.dirty),
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
    })
  } catch {
    return createInstallationVersionInfo({
      version: fallbackVersion,
      channel: fallbackChannel,
      branch: fallbackChannel,
    })
  }
}
