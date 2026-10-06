import { cn } from "@/lib/utils"
import { skeletonClassName } from "@clawdi/shared/ui"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(skeletonClassName, className)}
      {...props}
    />
  )
}

export { Skeleton }
