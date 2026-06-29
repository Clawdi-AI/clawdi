import { ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "@/lib/router-link";

export function DevAuthBypassPage({ mode }: { mode: "sign-in" | "sign-up" }) {
	const title = mode === "sign-in" ? "Local Dev Sign In" : "Local Dev Sign Up";
	return (
		<main className="flex min-h-dvh items-center justify-center px-4">
			<section className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
				<div className="flex items-start gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<ShieldCheck className="size-5" />
					</div>
					<div className="min-w-0 space-y-1">
						<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
						<p className="text-sm text-muted-foreground">
							Dev auth bypass is enabled. The dashboard is using the local dev account.
						</p>
					</div>
				</div>
				<div className="mt-5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
					<div className="font-medium">Dev User</div>
					<div className="text-muted-foreground">dev@clawdi.local</div>
				</div>
				<Button asChild className="mt-5 w-full">
					<Link href="/">
						Open Dashboard
						<ArrowRight className="size-4" />
					</Link>
				</Button>
			</section>
		</main>
	);
}
