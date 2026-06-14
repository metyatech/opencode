import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import {
  isManagedAgent,
  managedAgentCurrentModel,
  MANUAL_AGENT_SELECTION_KEYS,
  MANAGED_AGENT_NOTICE,
  migrateAgentSwitchState,
  resolveAgentSwitch,
  resolveModelSelect,
  resolveSessionRestore,
  resolveVariantSelect,
  type ManualAgentSelection,
  type ManualAgentSelections,
} from "@/lib/managed-agent"
import { showToast } from "@opencode-ai/ui/toast"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
  manualByAgent?: ManualAgentSelections
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (dir: string, id: string) => `${dir}\n${id}`

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
    manualByAgent: cloneManual(value.manualByAgent),
  } satisfies State
}

const cloneManual = (current: ManualAgentSelections | undefined): ManualAgentSelections => {
  if (!current) return {}
  const next: ManualAgentSelections = {}
  for (const key of Object.keys(current)) {
    const value = current[key]
    if (!value) continue
    next[key] = {
      ...(value.model ? { model: { ...value.model } } : {}),
      ...(value.variant !== undefined ? { variant: value.variant } : {}),
    }
  }
  return next
}

const mergeManualSelections = (
  previous: ManualAgentSelections | undefined,
  incoming: ManualAgentSelections | undefined,
): ManualAgentSelections => {
  if (!previous) return cloneManual(incoming)
  if (!incoming) return cloneManual(previous)
  const next = cloneManual(previous)
  for (const key of Object.keys(incoming)) {
    const value = incoming[key]
    if (!value) continue
    next[key] = {
      ...(value.model ? { model: { ...value.model } } : {}),
      ...(value.variant !== undefined ? { variant: value.variant } : {}),
    }
  }
  return next
}

const manualSelectionFromState = (value: State | undefined): ManualAgentSelection | undefined => {
  if (!value?.agent) return undefined
  const entry: ManualAgentSelection = {}
  if (value.model) entry.model = { providerID: value.model.providerID, modelID: value.model.modelID }
  if (value.variant !== undefined) entry.variant = value.variant
  if (!entry.model && entry.variant === undefined) return undefined
  return entry
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const providers = useProviders()
    const models = useModels()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync.data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved] = persisted(
      {
        ...Persist.workspace(sdk.directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return
      return items.find((item) => item.name === name) ?? items[0]
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    // Spec #5 / Item #8: the persisted `Saved.session[session]` payload
    // may predate the `manualByAgent` field. Migrate it on the fly so
    // legacy per-agent model picks survive the upgrade without losing
    // the existing session state. We never wipe the legacy fields --
    // we only add `manualByAgent` next to them.
    createEffect(() => {
      const session = id()
      if (!session) return
      const existing = saved.session[session]
      if (!existing) return
      if (existing.manualByAgent !== undefined) return
      const migrated = migrateAgentSwitchState(existing, (name) => list().find((item) => item.name === name))
      if (!migrated) return
      setSaved("session", session, migrated)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft
      return saved.session[session] ?? handoff.get(handoffKey(sdk.directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(sdk.directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
    })

    const configuredModel = () => {
      if (!sync.data.config.model) return
      const [providerID, modelID] = sync.data.config.model.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const currentAgentName = () => agent.current()?.name

    const manualForCurrent = (): ManualAgentSelection | undefined => {
      const name = currentAgentName()
      if (!name) return undefined
      return scope()?.manualByAgent?.[name]
    }

    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? store.current)
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          // Spec #5 / Item #8: switching INTO a managed agent clears
          // the active manual model/variant and clears that agent's
          // own manual slot. Switching INTO a normal agent restores
          // the prior per-agent pick with precedence
          // 1) manualByAgent[target]
          // 2) target's own configured model/variant
          // 3) the in-flight session/draft pick.
          const next = resolveAgentSwitch(item, scope()) satisfies State
          const session = id()
          if (session) {
            setSaved("session", session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = () => {
      const managed = agent.current()
      // Spec #5 / Item #7: a managed agent's model is fixed by the
      // agent config. Do NOT consult the saved per-session/draft
      // model, the recent list, a provider default, the previous
      // normal agent's model, or any other fallback. A managed agent
      // with no model yields `current model = undefined`. The UI
      // renders the managed agent's "Auto" label in that case.
      if (managed && isManagedAgent(managed)) {
        const item = managedAgentCurrentModel(managed)
        if (!item) return
        return models.find(item)
      }
      const item = firstModel(
        () => {
          const manual = manualForCurrent()
          if (!manual?.model) return undefined
          return { ...manual.model }
        },
        () => scope()?.model,
        () => agent.current()?.model,
        fallback,
      )
      if (!item) return
      return models.find(item)
    }

    const agentIsManaged = createMemo(() => isManagedAgent(agent.current()))

    const notifyManagedAgentLocked = () => {
      showToast({ description: MANAGED_AGENT_NOTICE })
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = (): string | null | undefined => {
      const manual = manualForCurrent()
      if (manual?.variant !== undefined) return manual.variant
      return scope()?.variant
    }

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
        manualByAgent: cloneManual(scope()?.manualByAgent),
      } satisfies State
    }

    const write = (next: State) => {
      const session = id()
      if (session) {
        setSaved("session", session, next)
        return
      }
      setStore("draft", next)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        if (agentIsManaged()) {
          notifyManagedAgentLocked()
          return
        }
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        if (agentIsManaged()) {
          notifyManagedAgentLocked()
          return
        }
        const name = currentAgentName()
        if (!name) return
        batch(() => {
          setStore("last", {
            type: "model",
            agent: name,
            model: item ?? null,
            variant: selected(),
          })
          // Spec #5 / Item #8: writing a model on a normal agent
          // updates the active selection AND records the pick into
          // `manualByAgent[currentAgent]` so it survives a future
          // managed-agent round-trip.
          const prior = scope() ?? { agent: name }
          const next = resolveModelSelect(name, item, prior) satisfies State
          write(next)
          if (!item) return
          models.setVisibility(item, true)
          if (!options?.recent) return
          models.recent.push(item)
        })
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          if (agentIsManaged()) {
            notifyManagedAgentLocked()
            return
          }
          const name = currentAgentName()
          if (!name) return
          batch(() => {
            const model = current()
            setStore("last", {
              type: "variant",
              agent: name,
              model: model ? { providerID: model.provider.id, modelID: model.id } : null,
              variant: value ?? null,
            })
            const prior = scope() ?? { agent: name }
            // Spec #5 / Item #8: the variant pick is recorded into
            // `manualByAgent[currentAgent].variant` so it survives a
            // future managed-agent round-trip.
            const next = resolveVariantSelect(name, value ?? null, prior) satisfies State
            write(next)
            if (model) {
              models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
            }
          })
        },
        cycle() {
          if (agentIsManaged()) {
            notifyManagedAgentLocked()
            return
          }
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
      agentIsManaged,
      session: {
        reset() {
          setStore("draft", undefined)
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return

          if (dir === sdk.directory) {
            setSaved("session", session, next)
            setStore("draft", undefined)
            return
          }

          handoff.set(handoffKey(dir, session), next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(sdk.directory, session))) return

          const restoredAgent = list().find((item) => item.name === msg.agent)
          // Spec #5 / Item #8: a managed agent must not pull a stale
          // message-time model into the local selection, and the
          // message-time model must NOT be recorded in
          // `manualByAgent`. A user-managed agent's message-time
          // model IS recorded in `manualByAgent[target]` so the
          // user's last pick survives a future managed-agent
          // round-trip.
          const prior = saved.session[session]
          setSaved(
            "session",
            session,
            resolveSessionRestore(restoredAgent, msg, prior) satisfies State,
          )
        },
      },
    }
    return result
  },
})

// Re-export the manual selection keys so they are discoverable from the
// app side without leaking internal managed-agent details.
export { MANUAL_AGENT_SELECTION_KEYS }
