"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { labelClassName } from "@clawdi/shared/ui"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        labelClassName,
        className
      )}
      {...props}
    />
  )
}

export { Label }
