import { auth } from "@clerk/nextjs/server";
import { Clock, Hash, MessageSquare, Zap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AgentInline } from "@/components/dashboard/agent-label";
import { DetailMeta, DetailStats, DetailTitle } from "@/components/detail/layout";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { MessageList } from "@/components/sessions/message-list";
import { SessionSidebar } from "@/components/sessions/session-sidebar";
import { ShareHeaderUser } from "@/components/share/header-user";
import { NoAccess } from "@/components/share/no-access";
import { SignInToView } from "@/components/share/sign-in-to-view";
import type { SessionMessage } from "@/lib/api-schemas";
import { env } from "@/lib/env";
import { formatDuration } from "@/lib/format";
import {
	formatAbsoluteTooltip,
	formatNumber,
	formatSessionSummary,
	relativeTime,
} from "@/lib/utils";

/**
 * Public share page for a Clawdi session.
 *
 * Server component — must work for curl, link unfurlers, and agents that
 * don't run JavaScript. Mirrors the dashboard `/sessions/[id]` layout
 * (DetailTitle / DetailMeta / SessionSidebar / DetailStats / message
 * stream) so a visitor's view of a session looks the same as the owner's
 * — minus owner-only chrome (no share controls, no breadcrumb, no
 * direction toggle, no infinite-pagination — first page is enough for
 * the visit-then-leave use case).
 *
 * Auth: optional. JWT is forwarded so the backend can identify the
 * session owner — owner sees the same view as a visitor (no extra
 * banner / chrome — owners who want full controls go to the dashboard
 * `/sessions/{id}` instead).
 *
 * URL: `/s/{session_id}` (UUID). Backend `/api/public/sessions/{id}` is
 * the canonical route.
 *
 * Status responses from the backend get a dedicated view:
 *   200 → render session
 *   401 → `<SignInToView />` (anon visitor, session is private)
 *   403 → `<NoAccess />` (signed in, no grant)
 *   404 → `notFound()` (session doesn't exist)
 */

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { id: string };

type PublicShare = {
	id: string;
	summary: string | null;
	project_path: string | null;
	agent_type: string | null;
	model: string | null;
	models_used: string[] | null;
	started_at: string;
	ended_at: string | null;
	last_activity_at: string;
	duration_seconds: number | null;
	message_count: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	tags: string[] | null;
	status: string;
	related_refs: {
		prs?: string[] | null;
		repos?: string[] | null;
		branches?: string[] | null;
	} | null;
	// Public identity of the session owner. Optional — pre-Clerk-login
	// users may have no `name`, and avatar is only populated after the
	// owner has signed in at least once post the avatar_url migration.
	owner_name: string | null;
	owner_avatar_url: string | null;
};

type PublicMessagesPage = {
	items: SessionMessage[];
	total: number;
	offset: number;
	limit: number;
};

type FetchResult =
	| { kind: "ok"; share: PublicShare }
	| { kind: "unauthorized" }
	| { kind: "forbidden" }
	| { kind: "not-found" };

/**
 * `token` is passed as an argument (rather than calling `auth()` inside)
 * because Clerk's `auth()` returns an object with non-serializable refs
 * that React's `cache()` chokes on. Caller resolves the JWT once outside
 * this boundary.
 */
const fetchShare = cache(async (sessionId: string, token: string | null): Promise<FetchResult> => {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/public/sessions/${sessionId}`, {
		cache: "no-store",
		headers,
	});
	if (res.status === 404) return { kind: "not-found" };
	if (res.status === 401) return { kind: "unauthorized" };
	if (res.status === 403) return { kind: "forbidden" };
	if (!res.ok) throw new Error(`backend returned ${res.status}`);
	const share = (await res.json()) as PublicShare;
	return { kind: "ok", share };
});

async function getOptionalToken(): Promise<string | null> {
	const { getToken } = await auth();
	return await getToken();
}

async function fetchFirstMessages(
	sessionId: string,
	token: string | null,
): Promise<PublicMessagesPage> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch(
		`${env.NEXT_PUBLIC_API_URL}/api/public/sessions/${sessionId}/messages?offset=0&limit=${PAGE_SIZE}`,
		{ cache: "no-store", headers },
	);
	if (!res.ok) {
		// Soft-failure: render the header even if messages errored.
		return { items: [], total: 0, offset: 0, limit: PAGE_SIZE };
	}
	return res.json() as Promise<PublicMessagesPage>;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
	const { id } = await params;
	if (!UUID_RE.test(id)) {
		return { title: "Shared session", robots: { index: false, follow: false } };
	}
	const token = await getOptionalToken();
	const result = await fetchShare(id, token);
	if (result.kind !== "ok") {
		return { title: "Shared session", robots: { index: false, follow: false } };
	}
	const share = result.share;
	const title = share.summary || `Clawdi session ${share.id.slice(0, 8)}`;
	return {
		title,
		description: share.summary || "A shared Clawdi session",
		// Unlisted-style by default; promote when we ship a Public profile tier.
		robots: { index: false, follow: false },
		openGraph: { title, description: share.summary || undefined },
		twitter: { card: "summary", title, description: share.summary || undefined },
	};
}

export default async function PublicSharePage({ params }: { params: Promise<Params> }) {
	const { id } = await params;

	const token = await getOptionalToken();
	const result = await fetchShare(id, token);
	if (result.kind === "not-found") notFound();
	if (result.kind === "unauthorized") return <SignInToView shareUrl={`/s/${id}`} />;
	if (result.kind === "forbidden") return <NoAccess />;

	const share = result.share;
	const messagesPage = await fetchFirstMessages(id, token);

	const summaryText = formatSessionSummary(share.summary) || `Session ${share.id.slice(0, 8)}`;
	const totalTokens = (share.input_tokens ?? 0) + (share.output_tokens ?? 0);
	const mdUrl = `/s/${share.id}.md`;
	const jsonUrl = `/s/${share.id}.json`;
	const truncated = messagesPage.total > messagesPage.items.length;

	return (
		<>
			<ShareHeader />
			<div className="mx-auto max-w-4xl space-y-5 px-4 py-6 lg:px-6">
				<div className="space-y-2">
					<DetailTitle>{summaryText}</DetailTitle>
					<DetailMeta>
						<AgentInline machineName={null} type={share.agent_type} />
						{share.project_path ? (
							<>
								<span>·</span>
								<span className="truncate font-mono">{share.project_path}</span>
							</>
						) : null}
						<span>·</span>
						<span title={formatAbsoluteTooltip(share.started_at)}>
							Started {relativeTime(share.started_at)}
						</span>
						{Math.abs(
							new Date(share.last_activity_at).getTime() - new Date(share.started_at).getTime(),
						) >
						5 * 60_000 ? (
							<>
								<span>·</span>
								<span title={formatAbsoluteTooltip(share.last_activity_at)}>
									Last activity {relativeTime(share.last_activity_at)}
								</span>
							</>
						) : null}
					</DetailMeta>
				</div>

				<SessionSidebar relatedRefs={share.related_refs} />

				<DetailStats>
					<ModelBadge modelId={share.model} />
					<Stat icon={MessageSquare} label={`${share.message_count} messages`} />
					<Stat icon={Zap} label={`${formatNumber(totalTokens)} tokens`} />
					{share.duration_seconds ? (
						<Stat icon={Clock} label={formatDuration(share.duration_seconds)} />
					) : null}
					<Stat icon={Hash} label={share.id.slice(0, 8)} title={share.id} />
				</DetailStats>

				{messagesPage.items.length === 0 ? (
					<p className="text-sm text-muted-foreground">This session has no readable content.</p>
				) : (
					<div>
						<MessageList
							messages={messagesPage.items}
							agentType={share.agent_type}
							userAvatar={share.owner_avatar_url ?? undefined}
							userName={share.owner_name || "User"}
						/>
					</div>
				)}

				{truncated ? (
					<p className="text-xs text-muted-foreground">
						Showing first {messagesPage.items.length} of {messagesPage.total} messages. Fetch the
						full conversation via{" "}
						<Link href={mdUrl} className="underline">
							{mdUrl}
						</Link>{" "}
						or{" "}
						<Link href={jsonUrl} className="underline">
							{jsonUrl}
						</Link>
						.
					</p>
				) : null}

				<footer className="border-t pt-4 text-xs text-muted-foreground">
					Shared via{" "}
					<Link href="/" className="font-medium underline-offset-4 hover:underline">
						Clawdi Cloud
					</Link>
				</footer>
			</div>
		</>
	);
}

/**
 * Top header bar for the public share page. Logo + product name on the
 * left edge (matches Notion / Amp / Linear: brand chrome lives at the
 * viewport edge, not aligned to the centered content column, and
 * clicking it goes home). User avatar + menu on the right edge — same
 * affordance the dashboard sidebar's bottom button provides, so theme
 * + sign-out are one click away wherever the user lands.
 */
function ShareHeader() {
	return (
		// sticky + opaque background — long sessions can scroll many
		// screen-heights, and the brand chrome needs to stay visible so
		// visitors keep their bearings and can click home from anywhere.
		// Matches Notion / Linear / GitHub Gist / ChatGPT share pages.
		<header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
			<div className="flex items-center justify-between px-4 py-3 lg:px-6">
				<Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
					<Image
						src="/clawdi-logo-transparent.png"
						alt=""
						width={28}
						height={28}
						className="size-7 shrink-0"
					/>
					<span className="text-sm font-semibold tracking-tight">Clawdi Cloud</span>
				</Link>
				<ShareHeaderUser />
			</div>
		</header>
	);
}
