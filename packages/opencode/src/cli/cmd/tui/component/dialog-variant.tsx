import { createEffect, createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"
import { MANAGED_AGENT_NOTICE } from "@tui/context/managed-agent"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()

  createEffect(() => {
    if (!local.agentIsManaged()) return
    toast.show({
      variant: "info",
      message: MANAGED_AGENT_NOTICE,
      duration: 3000,
    })
    dialog.clear()
  })

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(undefined)
        },
      },
      ...local.model.variant.list().map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(variant)
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
