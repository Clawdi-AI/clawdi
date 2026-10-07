"use client";

import { createHostedComputeClient } from "@clawdi/shared/api";
import {
	accountDeletionCopy as copy,
	deleteAccountThenSignOut,
	endDeletedAccountSession,
	STORE_SUBSCRIPTIONS_URL,
	settingsCopy,
} from "@clawdi/shared/view";
import { UserProfile, useClerk } from "@clerk/tanstack-react-start";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { DEPLOY_API_URL, isDeployApiConfigured } from "@/hosted/access/api";
import { useAuthActions, useAuthToken, useCurrentUser } from "@/lib/auth-client";

/**
 * Clerk's `openUserProfile()` modal cannot host React custom pages, so the hosted
 * deletion page renders Clerk's `<UserProfile>` component with `<UserProfile.Page>`.
 * Used only while Clerk self-deletion is disabled; otherwise Web keeps the modal.
 *
 * Clerk's own modals (e.g. reverification) receive focus inside this modal dialog.
 * Escape closes this dialog together with an open Clerk menu or modal (Clerk's own
 * profile modal closes only the menu); Base UI has no option to defer to Clerk.
 */
export function AccountProfileDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	// Clerk's hash routing leaves `#/…` behind; reopening must start at the profile root.
	const clearProfileRoute = (nextOpen: boolean) => {
		if (!nextOpen && window.location.hash.startsWith("#/"))
			void router.navigate({ to: ".", search: true, replace: true, resetScroll: false });
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={clearProfileRoute}>
			<DialogContent
				data-hosted="true"
				className="w-auto gap-0 bg-transparent p-0 ring-0 sm:max-w-fit"
			>
				<DialogTitle className="sr-only">{settingsCopy.manageAccount}</DialogTitle>
				<UserProfile routing="hash">
					<UserProfile.Page
						label={copy.title}
						url="delete-account"
						labelIcon={<Trash2 className="size-4" />}
					>
						<DeleteAccountPage />
					</UserProfile.Page>
				</UserProfile>
			</DialogContent>
		</Dialog>
	);
}

function DeleteAccountPage() {
	const { user } = useCurrentUser();
	const { getToken } = useAuthToken();
	const { signOut } = useAuthActions();
	const clerk = useClerk();
	const compute = useMemo(
		() =>
			isDeployApiConfigured()
				? createHostedComputeClient({
						baseUrl: DEPLOY_API_URL,
						getToken,
						fetch: (request, init) => fetch(request, init),
					})
				: null,
		[getToken],
	);
	const [outcome, setOutcome] = useState<"idle" | "deleting" | "uncertain">("idle");
	const [signingOut, setSigningOut] = useState(false);
	const email = user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "";
	const endSession = async () => {
		const ended = await endDeletedAccountSession(
			{
				get session() {
					return clerk.session;
				},
				signOut: (options) => signOut({ redirectUrl: options?.redirectUrl }),
				setActive: (params) => clerk.setActive(params),
				addListener: (listener) => clerk.addListener(listener),
			},
			{ redirectUrl: "/sign-in" },
		);
		// Always reload into the signed-out state, whichever path ended the session.
		window.location.assign("/sign-in");
		return ended;
	};
	const leave = async () => {
		setSigningOut(true);
		await endSession();
	};
	const confirm = async () => {
		if (!compute || outcome !== "idle") return;
		setOutcome("deleting");
		const result = await deleteAccountThenSignOut({
			deleteAccount: () => compute.deleteAccount(),
			endSession,
		});
		if (result.outcome === "uncertain") setOutcome("uncertain");
	};

	return (
		<div data-hosted="true" className="flex flex-col gap-4 text-sm">
			<div className="flex flex-col gap-1">
				<h1 className="text-base font-medium">{copy.title}</h1>
				<p className="text-muted-foreground">{email}</p>
			</div>
			<p>{copy.warning}</p>
			<p>{copy.billing}</p>
			<Alert variant="destructive">
				<TriangleAlert />
				<AlertTitle>{copy.storeNoticeTitle}</AlertTitle>
				<AlertDescription>{copy.storeNotice}</AlertDescription>
			</Alert>
			<div className="flex flex-wrap gap-2">
				<Button
					render={<a href={STORE_SUBSCRIPTIONS_URL.appStore} target="_blank" rel="noreferrer" />}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					<ExternalLink />
					{copy.manageAppStore}
				</Button>
				<Button
					render={<a href={STORE_SUBSCRIPTIONS_URL.googlePlay} target="_blank" rel="noreferrer" />}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					<ExternalLink />
					{copy.manageGooglePlay}
				</Button>
			</div>
			{outcome === "idle" ? (
				compute ? (
					<div>
						<ConfirmAction
							title={copy.confirmTitle}
							description={
								<>
									<span className="block">{email}</span>
									<span className="mt-2 block">{copy.warning}</span>
									<span className="mt-2 block">{copy.billing}</span>
								</>
							}
							cancelLabel={copy.cancel}
							confirmLabel={copy.confirm}
							destructive
							onConfirm={confirm}
						>
							<Button variant="destructive" size="sm">
								{copy.action}
							</Button>
						</ConfirmAction>
					</div>
				) : (
					<Alert>
						<AlertDescription>{copy.unavailable}</AlertDescription>
					</Alert>
				)
			) : outcome === "deleting" ? (
				<p className="flex items-center gap-2">
					<Spinner />
					{copy.deleting}
				</p>
			) : (
				<>
					<Alert variant="destructive">
						<AlertDescription>{copy.uncertain}</AlertDescription>
					</Alert>
					<div>
						<Button variant="outline" size="sm" disabled={signingOut} onClick={() => void leave()}>
							{copy.signOut}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
