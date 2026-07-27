import { ExternalLink, LayoutDashboard } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AppNotFound() {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			<section className="w-full max-w-md text-center">
				<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">404</p>
				<h1 className="mt-2 text-xl font-semibold">Page not found</h1>
				<p className="mt-2 text-sm text-muted-foreground">This Clawdi page does not exist.</p>
				<div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
					<a href="/" className={cn(buttonVariants())}>
						<LayoutDashboard data-icon="inline-start" />
						Back to dashboard
					</a>
					<a href="https://clawdi.ai" className={cn(buttonVariants({ variant: "outline" }))}>
						Go to Clawdi website
						<ExternalLink data-icon="inline-end" />
					</a>
				</div>
			</section>
		</main>
	);
}
