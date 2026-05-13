import { GitBranch, GitPullRequest, type LucideIcon, Package } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Compact session metadata row, rendered between the stats line and the
 * message timeline. Each datum (PR refs / repos / branches) is a single
 * flex-wrap chip — collapses to one line on a wide screen and wraps on
 * narrow.
 *
 * Each chip is icon + value. The icon disambiguates the category.
 *
 * Hides itself entirely when there are no refs so old sessions
 * (uploaded before the refs migration) render unchanged.
 *
 * Used by both the owner-side detail page and the public share page —
 * purely presentational, no API calls, no mutations.
 */
export function SessionSidebar({
	relatedRefs,
	className,
}: {
	relatedRefs:
		| {
				prs?: string[] | null;
				repos?: string[] | null;
				branches?: string[] | null;
		  }
		| null
		| undefined;
	className?: string;
}) {
	const prs = relatedRefs?.prs ?? [];
	const repos = relatedRefs?.repos ?? [];
	const branches = relatedRefs?.branches ?? [];

	if (prs.length === 0 && repos.length === 0 && branches.length === 0) {
		return null;
	}

	return (
		<aside className={cn("flex flex-wrap items-center gap-1.5", className)}>
			{prs.slice(0, 5).map((pr) => (
				<PrChip key={`pr-${pr}`} pr={pr} />
			))}
			{prs.length > 5 ? (
				<Chip icon={GitPullRequest} title="More pull requests">
					+{prs.length - 5} more
				</Chip>
			) : null}

			{repos.slice(0, 3).map((r) => (
				<Chip
					key={`r-${r}`}
					icon={Package}
					title="Repository"
					href={`https://github.com/${r}`}
					mono
				>
					{r}
				</Chip>
			))}

			{branches.slice(0, 3).map((b) => (
				<Chip key={`b-${b}`} icon={GitBranch} title="Branch" mono>
					{b}
				</Chip>
			))}
		</aside>
	);
}

/**
 * Visual unit: bordered pill with an icon and a value. Becomes a link
 * when `href` is set. `mono` toggles tabular monospace for code-shaped
 * payloads (repo names, branch refs).
 */
function Chip({
	icon: Icon,
	title,
	href,
	mono,
	children,
}: {
	icon: LucideIcon;
	title: string;
	href?: string;
	mono?: boolean;
	children: React.ReactNode;
}) {
	const className = cn(
		"inline-flex max-w-full items-center gap-1.5 truncate rounded-md border bg-card/30 px-2 py-1 text-xs",
		mono && "font-mono",
		href && "hover:bg-accent hover:text-accent-foreground transition-colors",
	);
	const content = (
		<>
			<Icon className="size-3 shrink-0 text-muted-foreground" />
			<span className="truncate">{children}</span>
		</>
	);
	if (href) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer" title={title} className={className}>
				{content}
			</a>
		);
	}
	return (
		<span title={title} className={className}>
			{content}
		</span>
	);
}

// `pr` (not `ref`) — `ref` is React's forwarded-ref prop name; passing a
// string under that name in React 19 / Next.js 16 makes the RSC renderer
// treat the string as a real ref object and throw "Refs cannot be used in
// Server Components" at SSR time.
function PrChip({ pr }: { pr: string }) {
	const match = pr.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (!match) {
		return (
			<Chip icon={GitPullRequest} title="Pull request" mono>
				{pr}
			</Chip>
		);
	}
	const [, owner, repo, num] = match;
	return (
		<Chip
			icon={GitPullRequest}
			title="Pull request"
			href={`https://github.com/${owner}/${repo}/pull/${num}`}
			mono
		>
			{pr}
		</Chip>
	);
}
