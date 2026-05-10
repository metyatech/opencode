declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_VERSION_INFO: string
}

import {
  createInstallationVersionInfo,
  extractBaseVersion,
  formatPreviewVersion,
  normalizeVersionChannel,
  parseInstallationVersionInfo,
  shortCommitSha,
} from "./version-metadata"
export type { InstallationVersionInfo, PreviewVersionInput } from "./version-metadata"

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationBaseVersion = extractBaseVersion(InstallationVersion)
export const InstallationVersionDetails = parseInstallationVersionInfo(
  typeof OPENCODE_VERSION_INFO === "string" ? OPENCODE_VERSION_INFO : undefined,
  InstallationVersion,
  InstallationChannel,
)

export {
  createInstallationVersionInfo,
  formatPreviewVersion,
  normalizeVersionChannel,
  parseInstallationVersionInfo,
  shortCommitSha,
}
