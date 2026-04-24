import { SignOutButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import { ShieldAlert } from "lucide-react";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { allowlistIsActive, isEmailAllowed } from "@/lib/email-allowlist";

/**
 * Generic denial page. Deliberately does not leak *why* — no allowed-domain
 * list, no "request access" affordance, no marketing copy. Just "nope" and
 * a sign-out button. Users who can't see the app shouldn't learn anything
 * from this screen.
 *
 * Self-redirects to `/` when the gate is off or when the signed-in user
 * actually *is* allowed (covers someone typing /access-denied in the URL
 * bar directly).
 */
export default async function AccessDeniedPage() {
	if (!allowlistIsActive()) {
		redirect("/");
	}
	const user = await currentUser();
	const primaryEmail = user?.emailAddresses.find(
		(e) => e.id === user.primaryEmailAddressId,
	)?.emailAddress;
	if (isEmailAllowed(primaryEmail)) {
		redirect("/");
	}
	return (
		<main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-6 px-6 text-center">
			<ShieldAlert className="size-12 text-muted-foreground" aria-hidden />
			<h1 className="text-xl font-semibold tracking-tight">Access denied</h1>
			<SignOutButton>
				<Button variant="outline">Sign out</Button>
			</SignOutButton>
		</main>
	);
}
