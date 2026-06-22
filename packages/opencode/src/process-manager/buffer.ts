import { ProcessEvent } from "./types"

// Bounded ring buffer keyed by monotonic `seq`. Pure data — no Effect, no
// streams, no Date.now() inside; the manager threads the timestamp in.
//
// Each appended chunk arrives already UTF-8-decoded from `Stream.decodeText`,
// so there are no byte-boundary concerns here. ANSI escapes and `\r\n` are
// preserved verbatim — the LLM caller is the one that interprets them.
//
// Once total bytes exceed `maxBytes`, oldest events are dropped FIFO. The
// dropped events are NOT reachable via `since(cursor)`; `truncatedBeforeCursor`
// is set on the response when at least one event with `seq <= cursor` was
// dropped.
export class RingBuffer {
  private readonly events: ProcessEvent[] = []
  private bytes = 0
  private nextSeq = 1
  private readonly maxBytes: number
  private firstDroppedSeq: number | null = null

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    if (maxBytes <= 0) throw new Error("RingBuffer maxBytes must be positive")
    this.maxBytes = maxBytes
  }

  append(kind: "stdout" | "stderr", text: string, at: number): { seq: number } {
    const seq = this.nextSeq++
    const event = new ProcessEvent({ kind, seq, text, at })
    this.events.push(event)
    this.bytes += Buffer.byteLength(text, "utf-8")

    while (this.bytes > this.maxBytes && this.events.length > 1) {
      const dropped = this.events.shift()
      if (!dropped) break
      this.bytes -= Buffer.byteLength(dropped.text, "utf-8")
      if (this.firstDroppedSeq === null) this.firstDroppedSeq = dropped.seq
    }

    return { seq }
  }

  // Returns events strictly newer than `cursor`. `nextCursor` is the seq the
  // caller should pass to the next `since()` call (the seq of the last event
  // returned, or `cursor` if nothing new).
  since(cursor: number): {
    events: ProcessEvent[]
    nextCursor: number
    truncatedBeforeCursor: boolean
  } {
    if (cursor < 0) cursor = 0

    const start =
      this.firstDroppedSeq !== null && cursor < this.firstDroppedSeq ? this.firstDroppedSeq : cursor
    const idx = this.events.findIndex((event) => event.seq > start)
    const events = idx === -1 ? [] : this.events.slice(idx)

    const truncatedBeforeCursor =
      this.firstDroppedSeq !== null && this.firstDroppedSeq <= cursor && this.events.length > 0

    const nextCursor = events.length === 0 ? Math.max(cursor, this.lastSeq()) : events[events.length - 1]!.seq
    return { events, nextCursor, truncatedBeforeCursor }
  }

  totalBytes(): number {
    return this.bytes
  }

  isEmpty(): boolean {
    return this.events.length === 0
  }

  // Test-only — exposes the current dropped floor so callers can assert the
  // truncation logic without poking at private state.
  _firstDroppedSeq(): number | null {
    return this.firstDroppedSeq
  }

  private lastSeq(): number {
    return this.events.length === 0 ? 0 : this.events[this.events.length - 1]!.seq
  }
}

export const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MiB
