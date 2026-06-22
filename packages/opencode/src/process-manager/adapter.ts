import { Context, Effect } from "effect"

import { Process } from "@/util/process"

// What we need from the live OS process — just enough to send signals.
// The shell tool owns the actual `ChildProcessHandle`; the manager never
// touches it directly. Callers pass the live handle in through the
// ProcessManager.promote(...) call and the adapter is invoked at stop time.
export interface LiveChild {
  readonly pid: number | null
  readonly kill: (signal?: NodeJS.Signals) => void
}

export interface StopInput {
  readonly pid: number
  readonly graceMs?: number
}

export interface ProcessAdapterService {
  readonly pid: (child: LiveChild) => number | undefined
  readonly stop: (input: StopInput) => Effect.Effect<void>
}

export class ProcessAdapter extends Context.Service<ProcessAdapter, ProcessAdapterService>()(
  "@opencode/ProcessAdapter",
) {}

// Windows: `taskkill /pid <pid> /f /t` — terminate the whole process tree.
// PID-only, NEVER `/IM` (a name flag could kill a system service with a
// matching basename). `/T` walks the child tree, `/F` forces termination
// without waiting for graceful shutdown. The CrossSpawnSpawner already
// uses `taskkill /pid /T /F` for its own scope cleanup; we mirror it here
// so the manager's stop semantics match the spawner's release path.
class WindowsProcessAdapter implements ProcessAdapterService {
  pid(child: LiveChild): number | undefined {
    return child.pid ?? undefined
  }

  stop(input: StopInput): Effect.Effect<void> {
    return Effect.promise(async () => {
      await Process.run(["taskkill", "/pid", String(input.pid), "/f", "/t"], { nothrow: true })
    }).pipe(Effect.asVoid)
  }
}

// Unix: send SIGTERM to the whole process group (`-pid`), then SIGKILL
// after `graceMs` if the process is still alive. `process.kill(-pid, sig)`
// throws ESRCH once the group is gone — that's the expected terminal state
// and is swallowed silently.
class UnixProcessAdapter implements ProcessAdapterService {
  pid(child: LiveChild): number | undefined {
    return child.pid ?? undefined
  }

  stop(input: StopInput): Effect.Effect<void> {
    const graceMs = input.graceMs ?? DEFAULT_GRACE_MS
    return Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          // First try the process group. ESRCH (no such process) is the only
          // expected error here — anything else is a real failure.
          try {
            process.kill(-input.pid, "SIGTERM")
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code
            if (code === "ESRCH") return resolve()
            throw err
          }

          setTimeout(() => {
            try {
              process.kill(-input.pid, "SIGKILL")
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code
              if (code !== "ESRCH") throw err
            }
            resolve()
          }, graceMs)
        }),
    ).pipe(Effect.ignore)
  }
}

const DEFAULT_GRACE_MS = 200

const unix = new UnixProcessAdapter()
const windows = new WindowsProcessAdapter()

export const liveAdapter: ProcessAdapterService =
  process.platform === "win32" ? windows : unix

export const liveProcessAdapter = ProcessAdapter.of(liveAdapter)

export * as ProcessAdapterNS from "./adapter"
