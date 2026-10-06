"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import type { VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { tabsClassName, tabsContentClassName, tabsListVariants, tabsTriggerActiveClassName, tabsTriggerClassName, tabsTriggerIndicatorClassName, tabsTriggerLineClassName } from "@clawdi/shared/ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        tabsClassName,
        className
      )}
      {...props}
    />
  )
}


function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        tabsTriggerClassName,
        tabsTriggerLineClassName,
        tabsTriggerActiveClassName,
        tabsTriggerIndicatorClassName,
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(tabsContentClassName, className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
