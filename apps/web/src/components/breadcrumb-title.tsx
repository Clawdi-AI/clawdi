"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { type AgentSectionId, agentSectionHref, agentSectionLabel } from "@/lib/agent-routes";

/**
 * Context for "what the breadcrumb's last segment should say".
 *
 * Without this, the breadcrumb falls back to the URL segment — which on
 * a detail page is a UUID, not anything a human can scan ("Sessions >
 * 54c28a79-c141-4f1d-a25e-d5249e…"). The dashboard layout wraps every
 * route in `<BreadcrumbTitleProvider>`; detail pages call
 * `useSetBreadcrumbTitle(session.summary)` once they have data.
 *
 * Setting `null` (or unmounting the consumer) clears the override and
 * the breadcrumb goes back to its URL-derived label — which is correct
 * on top-level pages (`/sessions` → "Sessions") and during loading
 * states.
 *
 * Implementation note: read and write live in *separate* contexts. If
 * we put `{title, setTitle}` in one object, every render of the provider
 * makes a new object identity — useEffect's deps change on every render,
 * the cleanup fires, and the title flickers to null between renders.
 * Splitting the contexts means the setter is stable (useState setters
 * always are), so the effect only re-runs when the *title input* changes.
 */

type SegmentTitles = Record<string, string>;

const TitleContext = createContext<string | null>(null);
const SegmentTitlesContext = createContext<SegmentTitles>({});
type Setter = (t: string | null) => void;
const SetTitleContext = createContext<Setter>(() => {});
type SegmentTitleSetter = (href: string | null | undefined, title: string | null) => void;
const SetSegmentTitleContext = createContext<SegmentTitleSetter>(() => {});

export function BreadcrumbTitleProvider({ children }: { children: React.ReactNode }) {
	const [title, setTitle] = useState<string | null>(null);
	const [segmentTitles, setSegmentTitles] = useState<SegmentTitles>({});
	const setSegmentTitle = useCallback<SegmentTitleSetter>((href, nextTitle) => {
		const normalizedHref = normalizeBreadcrumbHref(href);
		if (!normalizedHref) return;
		setSegmentTitles((current) => {
			const trimmed = nextTitle?.trim() || null;
			if (!trimmed) {
				if (!(normalizedHref in current)) return current;
				const { [normalizedHref]: _removed, ...rest } = current;
				return rest;
			}
			if (current[normalizedHref] === trimmed) return current;
			return { ...current, [normalizedHref]: trimmed };
		});
	}, []);
	return (
		<TitleContext.Provider value={title}>
			<SetTitleContext.Provider value={setTitle}>
				<SegmentTitlesContext.Provider value={segmentTitles}>
					<SetSegmentTitleContext.Provider value={setSegmentTitle}>
						{children}
					</SetSegmentTitleContext.Provider>
				</SegmentTitlesContext.Provider>
			</SetTitleContext.Provider>
		</TitleContext.Provider>
	);
}

/** Read-only accessor for the breadcrumb component itself. */
export function useBreadcrumbTitle(): string | null {
	return useContext(TitleContext);
}

export function useBreadcrumbSegmentTitles(): SegmentTitles {
	return useContext(SegmentTitlesContext);
}

/**
 * Detail pages call this with their human-readable title. Pass `null`
 * (or wait until data is ready) to fall back to the URL segment.
 *
 * Safe to call unconditionally — if `title` is null/undefined the effect
 * still runs but with no-op semantics. **Call this BEFORE any conditional
 * early-return**; React requires hook order to be stable across renders.
 */
export function useSetBreadcrumbTitle(title: string | null | undefined) {
	const setTitle = useContext(SetTitleContext);
	useEffect(() => {
		setTitle(title?.trim() || null);
		return () => setTitle(null);
	}, [setTitle, title]);
}

export function useSetBreadcrumbSegmentTitle(
	href: string | null | undefined,
	title: string | null | undefined,
) {
	const setSegmentTitle = useContext(SetSegmentTitleContext);
	useEffect(() => {
		setSegmentTitle(href, title?.trim() || null);
		return () => setSegmentTitle(href, null);
	}, [href, setSegmentTitle, title]);
}

export function useSetAgentBreadcrumbTitle({
	agentId,
	agentTitle,
	section = "overview",
	title,
}: {
	agentId?: string | null;
	agentTitle?: string | null;
	section?: AgentSectionId;
	/**
	 * Optional title for the current route's final segment. Omit it to use
	 * the agent name on Overview and the canonical section label elsewhere.
	 */
	title?: string | null;
}) {
	const normalizedAgentTitle = agentTitle?.trim() || null;
	const agentHref = agentId ? agentSectionHref(agentId) : null;
	const currentTitle =
		title !== undefined
			? title
			: section === "overview"
				? normalizedAgentTitle
				: agentSectionLabel(section);

	useSetBreadcrumbSegmentTitle(agentHref, normalizedAgentTitle);
	useSetBreadcrumbTitle(currentTitle);
}

function normalizeBreadcrumbHref(href: string | null | undefined): string | null {
	if (!href) return null;
	const [path] = href.split("?");
	const normalized = path.trim().replace(/\/+$/, "");
	if (!normalized || normalized === "/") return "/";
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
