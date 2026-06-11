import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function detectFileSymlinkSupport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-symlink-probe-"))
  const target = path.join(dir, "target.txt")
  const link = path.join(dir, "link.txt")

  try {
    fs.writeFileSync(target, "probe")
    fs.symlinkSync(target, link, "file")
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export const fileSymlinksAvailable = detectFileSymlinkSupport()

export const directorySymlinkType: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir"
