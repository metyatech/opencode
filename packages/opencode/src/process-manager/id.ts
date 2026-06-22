import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { withStatics } from "@opencode-ai/core/schema"

const processHandleSchema = Schema.String.check(Schema.isStartsWith("proc")).pipe(Schema.brand("ProcessHandle"))

export type ProcessHandle = typeof processHandleSchema.Type

export const ProcessHandle = processHandleSchema.pipe(
  withStatics((schema: typeof processHandleSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("process", id)),
  })),
)

// Self-reexport alias as `ProcessID` for callers that prefer the ID-style name.
export const ProcessID = ProcessHandle
export type ProcessID = ProcessHandle
