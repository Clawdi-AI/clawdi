"use client";

import { createHostedComputeClient } from "@clawdi/shared/api";
import {
	accountDeletionCopy as copy,
	deleteAccountThenSignOut,
	STORE_SUBSCRIPTIONS_URL,
	settingsCopy,
} from "@clawdi/shared/view";
import { UserProfile } from "@clerk/tanstack-react-start";
import { ExternalLink, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DEPLOY_API_URL, isDeployApiConfigured } from "@/hosted/access/api";
import { useAuthActions, useAuthToken, useCurrentUser } from "@/lib/auth-client";

/**
 * Clerk's `openUserProfile()` modal cannot host React custom pages, so the hosted
 * deletion page renders Clerk's `<UserProfile>` component with `<UserProfile.Page>`.
 * Used only while Clerk self-deletion is disabled; otherwise Web keeps the modal.
 */
export function AccountProfileDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
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
	const [outcome, setOutcome] = useState<"idle" | "uncertain" | "accepted">("idle");
	const [signingOut, setSigningOut] = useState(false);
	const [signOutFailed, setSignOutFailed] = useState(false);
	const email = user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "";
	const endSession = () => signOut({ redirectUrl: "/sign-in" });
	const leave = async () => {
		setSigningOut(true);
		setSignOutFailed(false);
		try {
			await endSession();
		} catch {
			setSignOutFailed(true);
		} finally {
			setSigningOut(false);
		}
	};
	const confirm = async () => {
		if (!compute || outcome !== "idle") return;
		const result = await deleteAccountThenSignOut({
			deleteAccount: () => compute.deleteAccount(),
			signOut: endSession,
		});
		if (result.outcome === "signed-out") return;
		setOutcome(result.outcome);
		if (result.outcome === "accepted") setSignOutFailed(true);
	};

	return (
		<div data-hosted="true" className="flex flex-col gap-4 text-sm">
			<div className="flex flex-col gap-1">
				<h1 className="text-base font-medium">{copy.title}</h1>
				<p className="text-muted-foreground">{email}</p>
			</div>
			<p>{copy.warning}</p>
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
			) : (
				<>
					<Alert variant="destructive">
						<AlertDescription>
							{outcome === "accepted" ? copy.accepted : copy.uncertain}
						</AlertDescription>
					</Alert>
					<div>
						<Button variant="outline" size="sm" disabled={signingOut} onClick={() => void leave()}>
							{copy.signOut}
						</Button>
					</div>
				</>
			)}
			{signOutFailed ? (
				<Alert variant="destructive">
					<AlertDescription>{copy.signOutFailed}</AlertDescription>
				</Alert>
			) : null}
		</div>
	);
}
