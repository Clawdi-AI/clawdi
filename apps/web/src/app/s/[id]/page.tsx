import type { components, paths } from "@clawdi/shared/api";
import { auth } from "@clerk/nextjs/server";
import { Clock, Hash, MessageSquare, Zap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import createClient from "openapi-fetch";
import { cache } from "react";
import { AgentInline } from "@/components/dashboard/agent-label";
import { DetailMeta, DetailStats, DetailTitle } from "@/components/detail/layout";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { MessageList } from "@/components/sessions/message-list";
import { SessionSidebar } from "@/components/sessions/session-sidebar";
import { ShareHeaderUser } from "@/components/share/header-user";
import { NoAccess } from "@/components/share/no-access";
import { PublicShareControls } from "@/components/share/public-share-controls";
import { SignInToView } from "@/components/share/sign-in-to-view";
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
 * — minus owner-only chrome (no visibility toggle, no breadcrumb, no
 * direction toggle, no infinite-pagination — first page is enough for
 * the visit-then-leave use case). Read-only share affordances (copy
 * link, copy Markdown/JSON URLs) live in `PublicShareControls`.
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

type PublicShare = components["schemas"]["PublicSessionResponse"];
type PublicMessagesPage = components["schemas"]["SessionMessagesPage"];

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
	const api = createPublicApi(token);
	const result = await api.GET("/api/public/sessions/{session_id}", {
		params: { path: { session_id: sessionId } },
		cache: "no-store",
	});
	if (result.response.status === 404) return { kind: "not-found" };
	if (result.response.status === 401) return { kind: "unauthorized" };
	if (result.response.status === 403) return { kind: "forbidden" };
	if (result.error !== undefined) throw new Error(`backend returned ${result.response.status}`);
	return { kind: "ok", share: result.data };
});

function createPublicApi(token: string | null) {
	return createClient<paths>({
		baseUrl: env.NEXT_PUBLIC_API_URL,
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});
}

async function getOptionalToken(): Promise<string | null> {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) return env.NEXT_PUBLIC_DEV_AUTH_TOKEN;
	const { getToken } = await auth();
	return await getToken();
}

async function fetchFirstMessages(
	sessionId: string,
	token: string | null,
): Promise<PublicMessagesPage> {
	const api = createPublicApi(token);
	const result = await api.GET("/api/public/sessions/{session_id}/messages", {
		params: { path: { session_id: sessionId }, query: { offset: 0, limit: PAGE_SIZE } },
		cache: "no-store",
	});
	if (result.error !== undefined) {
		// Soft-failure: render the header even if messages errored.
		return { items: [], total: 0, offset: 0, limit: PAGE_SIZE };
	}
	return result.data;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
	const { id } = await params;
	if (!UUID_RE.test(id)) {
		return sharedSessionFallbackMetadata();
	}
	const token = await getOptionalToken();
	const result = await fetchShare(id, token);
	if (result.kind !== "ok") {
		return sharedSessionFallbackMetadata();
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

function sharedSessionFallbackMetadata(): Metadata {
	const title = "Shared session";
	const description = "A shared Clawdi session";
	return {
		title,
		description,
		robots: { index: false, follow: false },
		openGraph: { title, description },
		twitter: { card: "summary", title, description },
	};
}

export default async function PublicSharePage({ params }: { params: Promise<Params> }) {
	const { id } = await params;
	if (!UUID_RE.test(id)) notFound();

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
	const showLastActivity =
		share.last_activity_at !== null &&
		Math.abs(new Date(share.last_activity_at).getTime() - new Date(share.started_at).getTime()) >
			5 * 60_000;

	return (
		<>
			<ShareHeader />
			{/* `w-full` pins this div to the body's cross-axis width even
			    though it's a flex item with `mx-auto`. Without it,
			    `mx-auto` (= `margin-inline: auto`) absorbs the cross-axis
			    free space and the item shrinks to fit its **content** —
			    which lets a `<pre>` rendered by `<Markdown>` push the
			    wrapper past the viewport and trigger page-level horizontal
			    scroll on narrow screens. `w-full` (`width: 100%`) restores
			    the "fill body, capped at max-w-4xl, then centered"
			    behavior that the visual design already assumed. */}
			<div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 lg:px-6">
				{/* Below `sm` (640px), controls drop under the title block —
				    a long summary then claims the full row instead of fighting
				    two icon buttons for ~80px on a 320px screen. Reverts to
				    the original side-by-side at `sm:` and up. */}
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0 flex-1 space-y-2">
						<DetailTitle>{summaryText}</DetailTitle>
						<DetailMeta>
							<AgentInline machineName={null} type={share.agent_type} />
							{share.project_path ? (
								<>
									<span>·</span>
									{/* `truncate` alone (= `white-space:nowrap`) lets the
									    span grow to its content inside a `flex-wrap`
									    parent — `max-w-full` caps it at the row's
									    content box and `min-w-0` breaks the flex
									    `min-width:auto` default so the ellipsis can
									    actually engage. */}
									<span
										className="min-w-0 max-w-full truncate font-mono"
										title={share.project_path}
									>
										{share.project_path}
									</span>
								</>
							) : null}
							<span>·</span>
							<span title={formatAbsoluteTooltip(share.started_at)}>
								Started {relativeTime(share.started_at)}
							</span>
							{showLastActivity ? (
								<>
									<span>·</span>
									<span title={formatAbsoluteTooltip(share.last_activity_at)}>
										Last activity {relativeTime(share.last_activity_at)}
									</span>
								</>
							) : null}
						</DetailMeta>
					</div>
					<div className="sm:shrink-0">
						<PublicShareControls sessionId={share.id} />
					</div>
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
					// `wrap-anywhere` breaks the long `/s/{uuid}.md|json` URLs at
					// any character — without it browsers treat the URL as one
					// atomic word and push the page wider than the viewport at
					// the `sm` breakpoint (where the available width is still
					// only ~640px). Same trick we use in `MessageBlock` bodies.
					<p className="text-xs text-muted-foreground wrap-anywhere">
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
						Clawdi
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
						className="size-7 shrink-0 rounded-md"
					/>
					<span className="text-sm font-semibold tracking-tight">Clawdi</span>
				</Link>
				<ShareHeaderUser />
			</div>
		</header>
	);
}
