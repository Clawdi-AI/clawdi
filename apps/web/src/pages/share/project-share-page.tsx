"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	AlertCircle,
	CheckCircle2,
	FileText,
	KeyRound,
	Lock,
	LogIn,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { useCurrentUser, useDashboardAuth } from "@/lib/auth-client";
import { projectDetailHref } from "@/lib/project-resource-model";

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

	const preview = useQuery({
		queryKey: ["share-preview", token],
		queryFn: async (): Promise<SharePreview> => {
			const result = await api.GET("/api/share/{token}/preview", {
				params: { path: { token } },
			});
			if (result.error !== undefined) throw shareErrorFromApi(result.response.status, result.error);
			return unwrap(result);
		},
		retry: false,
	});

	const upgrade = useMutation({
		mutationFn: async () => {
			const bearer = await getToken();
			if (!bearer) throw new ShareError("unknown");
			const result = await api.POST("/api/share/{token}/upgrade", {
				params: { path: { token } },
				body: { use_as: "attached" },
			});
			if (result.error !== undefined) throw shareErrorFromApi(result.response.status, result.error);
			return unwrap(result);
		},
		onSuccess: (result) => {
			void router.navigate({ href: `${projectDetailHref(result.project_id)}?joined=share` });
		},
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
						You've been invited to a Shared Project
					</div>
					<CardTitle className="mt-2 text-2xl">{data.project_name}</CardTitle>
					<p className="text-sm text-muted-foreground">
						Shared by <span className="font-medium text-foreground">{data.owner_display}</span>{" "}
						<span className="text-xs font-mono">@{data.owner_handle}</span>
					</p>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="grid grid-cols-2 gap-3">
						<ContentTile
							icon={<FileText className="size-5" />}
							label="Skills"
							count={data.skill_count}
							hint="Readable on any device"
						/>
						<ContentTile
							icon={<Lock className="size-5" />}
							label="Vaults"
							count={data.vault_count}
							hint="Key names only; values stay private"
							muted={data.vault_count === 0}
						/>
					</div>

					<ViewerAccessCard hasVaults={data.vault_count > 0} />

					<Separator />

					{upgrade.isSuccess ? (
						<Alert>
							<CheckCircle2 />
							<AlertTitle>You're In</AlertTitle>
							<AlertDescription>
								Added to your Projects with Viewer access. Adding it to an agent is a separate step.
								Redirecting…
							</AlertDescription>
						</Alert>
					) : isOwner ? (
						<Alert>
							<ShieldCheck />
							<AlertTitle>This is your project</AlertTitle>
							<AlertDescription>You don't need to accept it — it's already yours.</AlertDescription>
						</Alert>
					) : isSignedIn ? (
						<div className="space-y-3">
							<Button
								onClick={() => upgrade.mutate()}
								disabled={upgrade.isPending}
								className="w-full"
								size="lg"
							>
								<CheckCircle2 className="mr-2 size-4" />
								{upgrade.isPending ? "Joining…" : "Accept Project Access"}
							</Button>
							<p className="text-xs text-muted-foreground">
								You'll join as a <Badge variant="secondary">Viewer</Badge> with read access to
								skills
								{data.vault_count > 0 ? " and Vault values through CLI runtime reads" : ""}. The
								dashboard does not reveal key values.
							</p>
							{upgrade.error instanceof ShareError && upgrade.error.code === "already_member" ? (
								<Alert>
									<CheckCircle2 />
									<AlertDescription>
										You're already a member. Open the Project from your dashboard, then add it to an
										agent when needed.
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
							<Button asChild className="w-full" size="lg">
								<Link to="/sign-in" search={{ redirect_url: `/share/${token}` }}>
									<LogIn className="mr-2 size-4" />
									Continue in Browser
								</Link>
							</Button>
							<p className="text-xs text-muted-foreground">
								Sign in or create a free account. After signing in, click Accept here to join the
								Project.
							</p>
							<details className="group rounded-lg border bg-muted/30 p-4">
								<summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium marker:hidden">
									<KeyRound className="size-4 shrink-0" />
									<span>Advanced CLI Option</span>
								</summary>
								<p className="mt-1 text-xs text-muted-foreground">
									Use this if you're already familiar with command line tools. The browser flow
									above is the normal path.
								</p>
								<CopyableCommand command={`clawdi inbox accept ${buildLandingUrl(token)}`} />
							</details>
						</div>
					)}
				</CardContent>
			</Card>
			<p className="text-center text-xs text-muted-foreground">
				Shared Projects never grant write access. The owner can turn off this link anytime.
			</p>
		</Shell>
	);
}

function ViewerAccessCard({ hasVaults }: { hasVaults: boolean }) {
	const vaultCopy = hasVaults
		? "Use Vault values through CLI runtime reads"
		: "Use Vault values through CLI runtime reads if added later";
	return (
		<div className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm sm:grid-cols-2">
			<div className="space-y-2">
				<p className="font-medium">Viewer Can</p>
				<ul className="space-y-1.5 text-muted-foreground">
					<li className="flex items-center gap-2">
						<CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-foreground" />
						<span>View skills</span>
					</li>
					<li className="flex items-center gap-2">
						<CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-foreground" />
						<span>{vaultCopy}</span>
					</li>
				</ul>
			</div>
			<div className="space-y-2">
				<p className="font-medium">Viewer Cannot</p>
				<ul className="space-y-1.5 text-muted-foreground">
					<li className="flex items-center gap-2">
						<AlertCircle aria-hidden="true" className="size-4 shrink-0 text-foreground" />
						<span>Reveal key values in the dashboard</span>
					</li>
					<li className="flex items-center gap-2">
						<AlertCircle aria-hidden="true" className="size-4 shrink-0 text-foreground" />
						<span>Edit anything</span>
					</li>
				</ul>
			</div>
		</div>
	);
}

function ContentTile({
	icon,
	label,
	count,
	hint,
	muted,
}: {
	icon: React.ReactNode;
	label: string;
	count: number;
	hint: string;
	muted?: boolean;
}) {
	return (
		<div className={`rounded-lg border p-4 ${muted ? "bg-muted/20 text-muted-foreground" : ""}`}>
			<div className="flex items-center gap-2 text-sm">
				{icon}
				<span className="font-medium">{label}</span>
			</div>
			<div className="mt-2 text-2xl font-semibold">{count}</div>
			<div className="text-xs text-muted-foreground">{hint}</div>
		</div>
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
							.then(() => toast.success("Command Copied"))
							.catch(() =>
								toast.error("Couldn't Copy", {
									description: "Select the command and copy it manually.",
								}),
							);
					} else {
						toast.error("Couldn't Copy", {
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
					<AlertDescription>
						{error instanceof Error
							? error.message
							: "Share link unavailable. Ask the owner for a new link."}
					</AlertDescription>
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
			return "Share Link Not Found";
		case "revoked":
			return "Share Link Turned Off";
		case "already_member":
			return "Already a Member";
		case "already_owner":
			return "That's Your Project";
		default:
			return "Couldn't Load This Share";
	}
}

function describeError(code: ShareErrorCode): string {
	switch (code) {
		case "not_found":
			return "This link doesn't exist. Ask the owner to send you a fresh one.";
		case "revoked":
			return "The owner turned off this link. Ask them to send you a new one.";
		case "already_member":
			return "You already accepted this share. Open it from your dashboard.";
		case "already_owner":
			return "You own this Project. There is nothing to accept.";
		default:
			return "Please try again. If the problem persists, ping the owner.";
	}
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="w-full max-w-md space-y-4">{children}</div>
		</main>
	);
}
