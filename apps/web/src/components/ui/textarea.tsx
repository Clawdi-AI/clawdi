import * as React from "react"

import { cn } from "@/lib/utils"
import { textareaClassName } from "@clawdi/shared/ui"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        textareaClassName,
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
