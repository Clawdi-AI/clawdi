"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, KeyRound, LogIn, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { useCurrentUser, useDashboardAuth } from "@/lib/auth-client";
import { projectDetailHref } from "@/lib/project-resource-model";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/**
 * Public project-share landing page.
 *
 * Flow:
 *   1. Anonymous preview — call GET /api/share/{token}/preview,
 *      render project name, owner display+handle, skill/vault counts.
 *   2. Sign-in CTA upgrades to a permanent ProjectMembership.
 *   3. Agent use is explicit and handled separately after accept.
 */

type SharePreview = components["schemas"]["ShareRedeemResponse"];

function buildLandingUrl(token: string): string {
	if (typeof window === "undefined") return `/share/${token}`;
	return `${window.location.origin}/share/${token}`;
}

type ShareErrorCode = "not_found" | "revoked" | "already_member" | "already_owner" | "unknown";

class ShareError extends Error {
	constructor(
		public code: ShareErrorCode,
		public status?: number,
	) {
		super(code);
	}
}

function shareErrorFromApi(status: number, error: unknown): ShareError {
	if (status === 404) return new ShareError("not_found");
	if (status === 410) return new ShareError("revoked");
	if (status === 409) {
		return hasStructuredDetailError(error, "already_owner")
			? new ShareError("already_owner")
			: new ShareError("already_member");
	}
	return new ShareError("unknown", status);
}

function hasStructuredDetailError(error: unknown, code: string): boolean {
	if (typeof error !== "object" || error === null || !("detail" in error)) return false;
	const detail = error.detail;
	return (
		typeof detail === "object" && detail !== null && "error" in detail && detail.error === code
	);
}

export default function SharePage({ token }: { token: string }) {
	const api = useApi();
	const router = useRouter();
	const { isSignedIn, getToken } = useDashboardAuth();
	const { user } = useCurrentUser();
	const previewRequestRef = useRef(0);
	const [preview, setPreview] = useState<{
		data: SharePreview | null;
		error: unknown;
		isLoading: boolean;
	}>({ data: null, error: null, isLoading: true });
	const [upgradeSucceeded, setUpgradeSucceeded] = useState(false);

	useEffect(() => {
		const requestId = previewRequestRef.current + 1;
		previewRequestRef.current = requestId;
		setPreview({ data: null, error: null, isLoading: true });
		void (async () => {
			try {
				const result = await api.GET("/v1/share/{token}/preview", {
					params: { path: { token } },
				});
				if (result.error !== undefined)
					throw shareErrorFromApi(result.response.status, result.error);
				if (previewRequestRef.current === requestId) {
					setPreview({ data: unwrap(result), error: null, isLoading: false });
				}
			} catch (error) {
				if (previewRequestRef.current === requestId) {
					setPreview({ data: null, error, isLoading: false });
				}
			}
		})();
		return () => {
			previewRequestRef.current += 1;
		};
	}, [api, token]);

	const upgrade = useSensitiveAction(async () => {
		const bearer = await getToken();
		if (!bearer) throw new ShareError("unknown");
		const result = await api.POST("/v1/share/{token}/upgrade", {
			params: { path: { token } },
			body: { use_as: "attached" },
		});
		if (result.error !== undefined) throw shareErrorFromApi(result.response.status, result.error);
		const body = unwrap(result);
		setUpgradeSucceeded(true);
		void router.navigate({ href: `${projectDetailHref(body.project_id)}?joined=share` });
		return body;
	});

	if (preview.isLoading) {
		return (
			<Shell>
				<Skeleton className="h-64 w-full" />
			</Shell>
		);
	}

	if (preview.error) {
		return <ErrorView error={preview.error} />;
	}

	const data = preview.data;
	if (!data) return null;

	const profileOwnerHandle =
		(user?.publicMetadata?.project_owner_handle as string | undefined) ??
		(user?.publicMetadata?.owner_handle as string | undefined);
	const isOwner =
		profileOwnerHandle === data.owner_handle ||
		(upgrade.error instanceof ShareError && upgrade.error.code === "already_owner");

	return (
		<Shell>
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
						<Sparkles className="size-4" />
						Project invitation
					</div>
					<CardTitle className="mt-2 text-2xl">{data.project_name}</CardTitle>
					<p className="text-sm text-muted-foreground">
						Shared by <span className="font-medium text-foreground">{data.owner_display}</span>{" "}
						<span className="text-xs font-mono">@{data.owner_handle}</span>
					</p>
				</CardHeader>
				<CardContent className="space-y-6">
					<p className="text-sm text-muted-foreground">
						{data.skill_count} {data.skill_count === 1 ? "Skill" : "Skills"} · {data.vault_count}{" "}
						{data.vault_count === 1 ? "Vault" : "Vaults"}
					</p>

					<ViewerAccessSummary hasVaults={data.vault_count > 0} />

					<Separator />

					{upgradeSucceeded ? (
						<Alert>
							<CheckCircle2 />
							<AlertTitle>Invitation accepted</AlertTitle>
							<AlertDescription>Opening Project…</AlertDescription>
						</Alert>
					) : isOwner ? (
						<Alert>
							<ShieldCheck />
							<AlertTitle>This is your Project</AlertTitle>
							<AlertDescription>You already have access.</AlertDescription>
						</Alert>
					) : isSignedIn ? (
						<div className="space-y-3">
							<Button
								onClick={() => void upgrade.execute().catch(() => undefined)}
								disabled={upgrade.isPending}
								className="w-full"
								size="lg"
							>
								<CheckCircle2 className="mr-2 size-4" />
								{upgrade.isPending ? "Joining…" : "Accept invitation"}
							</Button>
							{upgrade.error instanceof ShareError && upgrade.error.code === "already_member" ? (
								<Alert>
									<CheckCircle2 />
									<AlertDescription>
										You already have access. Open this Project from your dashboard.
									</AlertDescription>
								</Alert>
							) : upgrade.error ? (
								<Alert variant="destructive">
									<AlertCircle />
									<AlertDescription>
										{describeError((upgrade.error as ShareError).code)}
									</AlertDescription>
								</Alert>
							) : null}
						</div>
					) : (
						<div className="space-y-4">
							<Button
								render={<Link to="/sign-in" search={{ redirect_url: `/share/${token}` }} />}
								nativeButton={false}
								className="w-full"
								size="lg"
							>
								<LogIn className="mr-2 size-4" />
								Sign in to accept
							</Button>
							<p className="text-xs text-muted-foreground">
								Sign in or create an account to accept this invitation.
							</p>
							<details className="group rounded-lg border bg-muted/30 p-4">
								<summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium marker:hidden">
									<KeyRound className="size-4 shrink-0" />
									<span>Accept with CLI</span>
								</summary>
								<CopyableCommand command={`clawdi inbox accept ${buildLandingUrl(token)}`} />
							</details>
						</div>
					)}
				</CardContent>
			</Card>
		</Shell>
	);
}

function ViewerAccessSummary({ hasVaults }: { hasVaults: boolean }) {
	return (
		<p className="text-sm text-muted-foreground">
			You can view this Project and link it to your Agents. Only the owner can edit.
			{hasVaults
				? " Your Agents and the Clawdi CLI can use its keys; secret values stay hidden in the dashboard."
				: ""}
		</p>
	);
}

function CopyableCommand({ command }: { command: string }) {
	return (
		<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
			<code className="flex-1 truncate rounded border bg-background px-2 py-1 font-mono text-xs">
				$ {command}
			</code>
			<Button
				variant="outline"
				size="sm"
				aria-label="Copy CLI accept command"
				onClick={() => {
					if (typeof navigator !== "undefined" && navigator.clipboard) {
						navigator.clipboard
							.writeText(command)
							.then(() => toast.success("Command copied"))
							.catch(() =>
								toast.error("Couldn't copy", {
									description: "Select the command and copy it manually.",
								}),
							);
					} else {
						toast.error("Couldn't copy", {
							description: "Select the command and copy it manually.",
						});
					}
				}}
			>
				Copy
			</Button>
		</div>
	);
}

function ErrorView({ error }: { error: unknown }) {
	if (!(error instanceof ShareError)) {
		return (
			<Shell>
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Something went wrong</AlertTitle>
					<AlertDescription>Couldn't load this invitation. Please try again.</AlertDescription>
				</Alert>
			</Shell>
		);
	}
	return (
		<Shell>
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>{titleForError(error.code)}</AlertTitle>
				<AlertDescription>{describeError(error.code)}</AlertDescription>
			</Alert>
		</Shell>
	);
}

function titleForError(code: ShareErrorCode): string {
	switch (code) {
		case "not_found":
			return "Invite link not found";
		case "revoked":
			return "Invite link unavailable";
		case "already_member":
			return "Already joined";
		case "already_owner":
			return "This is your Project";
		default:
			return "Couldn't load invitation";
	}
}

function describeError(code: ShareErrorCode): string {
	switch (code) {
		case "not_found":
			return "Ask the owner for a new invite link.";
		case "revoked":
			return "This invite link is no longer active. Ask the owner for a new one.";
		case "already_member":
			return "You already have access. Open this Project from your dashboard.";
		case "already_owner":
			return "You own this Project. There is nothing to accept.";
		default:
			return "Try again. If the problem continues, contact the owner.";
	}
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="w-full max-w-md space-y-4">{children}</div>
		</main>
	);
}
