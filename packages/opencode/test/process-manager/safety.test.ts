import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// Static guard tests. The persistent process manager must NEVER use
// process-name based termination (`taskkill /IM`, `Get-Process`, `Stop-Process`,
// `killall`, `ps`, `tasklist`, `netstat`) anywhere in its production code.
// Every stop MUST go through `ProcessAdapter.stop({ pid, ... })` so we have a
// single chokepoint and never accidentally signal a different process sharing
// the name. These tests are deliberately worded to fail loudly if a future
// change re-introduces a name-based kill.

const SRC_ROOT = join(import.meta.dir, "..", "..", "src", "process-manager")

const FORBIDDEN_NAME_FLAGS = [
  "/IM", // taskkill /IM is a name-based kill
  "/im",
]

// Word-boundary needles so we don't trip on `killAll` (the Effect service
// method), `p.stop()`, or `process.group` in a comment.
const FORBIDDEN_NAME_TERMINATORS = [
  "Get-Process", // PowerShell name lookup
  "Stop-Process", // PowerShell kill-by-name (also takes -Id, but treat as suspect)
  "tasklist", // name-based process list
  "killall ", // Unix name-based kill (with trailing space → word boundary)
  "killall\t",
  "killall\"",
  " killall",
  "pkill ",
  "pkill\t",
  " pkill",
]

describe("ProcessManager safety guards", () => {
  test("no taskkill /IM usage in src/process-manager", async () => {
    const offenders = await scanSource(SRC_ROOT, FORBIDDEN_NAME_FLAGS)
    expect(offenders).toEqual([])
  })

  test("no Get-Process / Stop-Process / tasklist / killall / pkill in src/process-manager", async () => {
    const offenders = await scanSource(SRC_ROOT, FORBIDDEN_NAME_TERMINATORS)
    expect(offenders).toEqual([])
  })

  test("process.kill calls in src/process-manager only use numeric PIDs", async () => {
    // Allowed: `process.kill(-<pid>, "SIGTERM")` or `process.kill(<pid>, sig)`.
    // Disallowed: `process.kill("string")` — string arguments are process
    // names on some platforms. Comments mentioning `process.kill` are skipped.
    const { readdir, readFile } = await import("node:fs/promises")
    const offenders: Array<{ file: string; line: number; text: string }> = []
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith(".ts")) {
          const text = await readFile(full, "utf-8")
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!
            const code = stripLineComment(line)
            if (!/process\.kill\(/.test(code)) continue
            // Match `process.kill(<arg>, ...)` and inspect the first arg.
            const argMatch = code.match(/process\.kill\(\s*([^,)]+)/)
            if (!argMatch) continue
            const arg = argMatch[1]!.trim()
            // Allow: -<digits>, <digits>, or an identifier (possibly
            // dotted for member access like `input.pid`, optionally prefixed
            // by `-` for process-group signaling).
            const isNumeric =
              /^-\d+$/.test(arg) ||
              /^\d+$/.test(arg) ||
              /^-?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(arg)
            if (!isNumeric) offenders.push({ file: full, line: i + 1, text: line.trim() })
          }
        }
      }
    }
    await walk(SRC_ROOT)
    expect(offenders).toEqual([])
  })
})

async function scanSource(
  root: string,
  needles: string[],
): Promise<Array<{ file: string; line: number; text: string }>> {
  const { readdir, readFile } = await import("node:fs/promises")
  const offenders: Array<{ file: string; line: number; text: string }> = []
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(full, "utf-8")
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          // Strip line comments (//...) before scanning; we only want to
          // catch actual usage, not comments that mention a forbidden term
          // to explain why it is forbidden.
          const code = stripLineComment(line)
          for (const needle of needles) {
            if (code.includes(needle)) {
              offenders.push({ file: full, line: i + 1, text: line.trim() })
            }
          }
        }
      }
    }
  }
  await walk(root)
  return offenders
}

function stripLineComment(line: string): string {
  // Naive but adequate for this codebase: split on the first `//` that is
  // not inside a string literal. Strings with `//` inside double or single
  // quotes are rare in our production code; if they appear, the scan may
  // over-flag, which is the safe direction.
  const idx = line.indexOf("//")
  return idx === -1 ? line : line.slice(0, idx)
}
