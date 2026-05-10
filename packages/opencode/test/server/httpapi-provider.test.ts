import { afterEach, describe, expect } from "bun:test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
const it = testEffect(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function app(experimental: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function requestAuthorize(input: {
  app: ReturnType<typeof app>
  providerID: string
  method: number
  headers: HeadersInit
}) {
  return Effect.promise(async () => {
    const response = await input.app.request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method }),
    })
    return {
      status: response.status,
      body: await response.text(),
    }
  })
}

function providerClient(input: {
  app: ReturnType<typeof app>
  directory: string
}) {
  const fetchFn = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const next = new Request(request, init)
    return input.app.fetch(next)
  }) as typeof globalThis.fetch
  return createOpencodeClient({
    baseUrl: "http://opencode.internal",
    directory: input.directory,
    fetch: fetchFn,
  })
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* fs.makeDirectory(path.join(dir, ".opencode", "plugin"), { recursive: true })
    yield* fs.writeFileString(
      path.join(dir, ".opencode", "plugin", "provider-oauth-parity.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-parity",',
        "  server: async () => ({",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderMissingCachePlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* fs.makeDirectory(path.join(dir, ".opencode", "plugin"), { recursive: true })
    yield* fs.writeFileString(
      path.join(dir, ".opencode", "plugin", "provider-missing-cache.ts"),
      [
        "export default {",
        '  id: "test.provider-missing-cache",',
        "  server: async () => ({",
        "    provider: {",
        '      id: "anthropic",',
        "      async models(provider) {",
        "        const first = Object.entries(provider.models)[0]?.[1]",
        "        if (!first) return provider.models",
        "        return {",
        "          ...provider.models,",
        '          "broken-plugin-model": {',
        "            ...first,",
        '            id: "broken-plugin-model",',
        '            name: "Broken Plugin Model",',
        "            cost: {",
        "              input: 1,",
        "              output: 2,",
        "            },",
        "          },",
        "        }",
        "      },",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function modelCost(input: unknown, providerID: string, modelID: string) {
  const data = (input ?? {}) as {
    all?: Array<{
      id?: string
      models?: Record<string, { cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } } }>
    }>
  }
  return data.all?.find((provider) => provider.id === providerID)?.models?.[modelID]?.cost
}

function withProviderProject<A, E, R>(
  self: (dir: string) => Effect.Effect<A, E, R>,
  config: Record<string, unknown> = {},
  setup?: (dir: string) => Effect.Effect<void, any, any>,
  includeAuthPlugin = true,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-test-" })

    yield* fs.writeFileString(
      path.join(dir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", formatter: false, lsp: false, ...config }),
    )
    if (includeAuthPlugin) {
      yield* writeProviderAuthPlugin(dir)
    }
    if (setup) {
      yield* setup(dir)
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        WithInstance.provide({ directory: dir, fn: () => InstanceRuntime.disposeInstance(Instance.current) }),
      ).pipe(Effect.ignore),
    )

    return yield* self(dir).pipe(provideInstance(dir))
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("provider HttpApi", () => {
  it.live(
    "normalizes plugin models with missing cost.cache through the SDK directory routing path",
    withProviderProject(
      (dir) =>
        Effect.gen(function* () {
          const httpapi = providerClient({ app: app(true), directory: dir })

          const httpapiResult = yield* Effect.promise(() => httpapi.provider.list({}, { throwOnError: false }))
          const httpapiCost = modelCost(httpapiResult.data, "anthropic", "broken-plugin-model")

          expect(httpapiResult.response.status).toBe(200)
          expect(httpapiCost).toEqual({
            input: 1,
            output: 2,
            cache: { read: 0, write: 0 },
          })
        }),
      {
        provider: {
          anthropic: {
            options: {
              apiKey: "test-key",
            },
          },
        },
      },
      writeProviderMissingCachePlugin,
      false,
    ),
  )

  it.live(
    "matches legacy provider list through the SDK directory routing path",
    withProviderProject((dir) =>
      Effect.gen(function* () {
        const legacy = app(false)
        const httpapi = providerClient({ app: app(true), directory: dir })

        const legacyResult = yield* Effect.promise(() =>
          providerClient({ app: legacy, directory: dir }).provider.list({}, { throwOnError: false }),
        )
        const httpapiResult = yield* Effect.promise(() => httpapi.provider.list({}, { throwOnError: false }))

        expect(httpapiResult.response.status).toEqual(legacyResult.response.status)
        expect(httpapiResult.data).toEqual(legacyResult.data)
        expect(httpapiResult.error).toEqual(legacyResult.error)
        expect(httpapiResult.response.status).toBe(200)
      }),
    ),
  )

  it.live(
    "matches legacy OAuth authorize response shapes",
    withProviderProject((dir) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": dir, "content-type": "application/json" }
        const legacy = app(false)
        const httpapi = app(true)

        const apiLegacy = yield* requestAuthorize({
          app: legacy,
          providerID,
          method: 0,
          headers,
        })
        const apiHttpApi = yield* requestAuthorize({
          app: httpapi,
          providerID,
          method: 0,
          headers,
        })
        expect(apiLegacy).toEqual({ status: 200, body: "" })
        expect(apiHttpApi).toEqual(apiLegacy)

        const oauthLegacy = yield* requestAuthorize({
          app: legacy,
          providerID,
          method: 1,
          headers,
        })
        const oauthHttpApi = yield* requestAuthorize({
          app: httpapi,
          providerID,
          method: 1,
          headers,
        })
        expect(oauthHttpApi).toEqual(oauthLegacy)
        expect(JSON.parse(oauthHttpApi.body)).toEqual({
          url: oauthURL,
          method: "code",
          instructions: oauthInstructions,
        })
      }),
    ),
  )
})
