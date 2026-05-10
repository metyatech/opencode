import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { InstallationVersion, InstallationVersionDetails, type InstallationVersionInfo } from "@opencode-ai/core/installation/version"

export function renderVersionOutput(
  asJson: boolean,
  details: InstallationVersionInfo = InstallationVersionDetails,
  version: string = InstallationVersion,
) {
  if (!asJson) return version
  return JSON.stringify(details, null, 2)
}

export const VersionCommand = cmd({
  command: "version",
  describe: "show version information",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      describe: "print structured version metadata",
      type: "boolean",
      default: false,
    }),
  async handler(args: { json?: boolean }) {
    console.log(renderVersionOutput(Boolean(args.json)))
  },
})
