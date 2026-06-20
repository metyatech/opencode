import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SESSION_SRC = path.join(import.meta.dir, "../../../src/session")

// `llm.ts` is the only file allowed to call `prepared.run(...)` on a
// `PreparedInvocation` — it is the owner of the AbortController, the
// provider request watchdog, and timeout-to-error conversion (see
// `LLM.streamPrepared`). Every other caller must go through
// `llm.streamPrepared(prepared)` instead.
//
// `llm/native-runtime.ts` is excluded: its local `prepared` binding (in the
// backward-compat `LLMNativeRuntime.stream` helper) is a `PreparedNative`,
// an unrelated internal type for the native-runtime request factory — not
// a `PreparedInvocation`. Excluding it here avoids a false positive on an
// unrelated `.run(...)` call.
const ALLOWED_CALLERS = new Set([path.join(SESSION_SRC, "llm.ts"), path.join(SESSION_SRC, "llm", "native-runtime.ts")])

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full))
      continue
    }
    if (full.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("PreparedInvocation.run call sites", () => {
  test("prepared.run( is only called from llm.ts", () => {
    const offenders: string[] = []
    for (const file of collectTsFiles(SESSION_SRC)) {
      if (ALLOWED_CALLERS.has(file)) continue
      const text = readFileSync(file, "utf8")
      if (/\bprepared\.run\(/.test(text)) offenders.push(path.relative(SESSION_SRC, file))
    }
    expect(offenders).toEqual([])
  })
})
