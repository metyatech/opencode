import { describe, expect, test } from "bun:test"
import { RingBuffer } from "../../src/process-manager/buffer"

describe("RingBuffer", () => {
  test("append returns monotonic seqs and is readable via since", () => {
    const buf = new RingBuffer(1024)
    const a = buf.append("stdout", "hello", 100)
    const b = buf.append("stderr", "world", 200)
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)

    const { events, nextCursor, truncatedBeforeCursor } = buf.since(0)
    expect(events.length).toBe(2)
    expect(events[0]!.text).toBe("hello")
    expect(events[1]!.text).toBe("world")
    expect(nextCursor).toBe(2)
    expect(truncatedBeforeCursor).toBe(false)
  })

  test("since with cursor returns only events strictly newer than the cursor", () => {
    const buf = new RingBuffer(1024)
    buf.append("stdout", "a", 1)
    buf.append("stdout", "b", 2)
    buf.append("stdout", "c", 3)

    const { events, nextCursor } = buf.since(1)
    expect(events.length).toBe(2)
    expect(events[0]!.seq).toBe(2)
    expect(events[1]!.seq).toBe(3)
    expect(nextCursor).toBe(3)
  })

  test("nextCursor is the cursor itself when no new events are available", () => {
    const buf = new RingBuffer(1024)
    buf.append("stdout", "only", 1)
    const { events, nextCursor } = buf.since(5)
    expect(events.length).toBe(0)
    expect(nextCursor).toBe(5)
  })

  test("FIFO drop when total bytes exceed maxBytes (oldest event is evicted)", () => {
    const buf = new RingBuffer(6)
    buf.append("stdout", "abc", 1) // 3 bytes
    buf.append("stdout", "defg", 2) // 4 bytes, total 7 > 6 -> "abc" dropped
    const { events } = buf.since(0)
    expect(events.length).toBe(1)
    expect(events[0]!.text).toBe("defg")
    expect(buf._firstDroppedSeq()).toBe(1)
    // truncatedBeforeCursor only flips when a drop is "behind" the cursor;
    // with cursor=0 and firstDroppedSeq=1, the reader hasn't actually been
    // denied an event it asked for, so the flag is false here.
    const { truncatedBeforeCursor } = buf.since(0)
    expect(truncatedBeforeCursor).toBe(false)
    // When the cursor moves past the dropped seq, the flag flips.
    const { truncatedBeforeCursor: t2 } = buf.since(1)
    expect(t2).toBe(true)
  })

  test("isEmpty and totalBytes track the current state", () => {
    const buf = new RingBuffer(1024)
    expect(buf.isEmpty()).toBe(true)
    expect(buf.totalBytes()).toBe(0)
    buf.append("stdout", "x", 1)
    expect(buf.isEmpty()).toBe(false)
    expect(buf.totalBytes()).toBe(1)
  })

  test("rejects non-positive maxBytes", () => {
    expect(() => new RingBuffer(0)).toThrow()
    expect(() => new RingBuffer(-1)).toThrow()
  })
})
