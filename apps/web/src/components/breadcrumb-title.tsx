"use client";

import { useLocation } from "@tanstack/react-router";
import {
	createContext,
	type Dispatch,
	type SetStateAction,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { type AgentSectionId, agentSectionHref, agentSectionLabel } from "@/lib/agent-routes";
import { APP_TITLE, formatDocumentTitle } from "@/lib/document-title";

/**
 * Context for "what the breadcrumb's last segment should say".
 *
 * Without this, the breadcrumb falls back to the URL segment — which on
 * a detail page is a UUID, not anything a human can scan ("Sessions >
 * 54c28a79-c141-4f1d-a25e-d5249e…"). The dashboard layout wraps every
 * route in `<BreadcrumbTitleProvider>`; detail pages call
 * `useSetBreadcrumbTitle(session.summary)` once they have data.
 *
 * Registrations are tied to the full route, including search params, so
 * navigation can never reuse a name from the previous resource context.
 * Dynamic names render a stable placeholder until their authoritative data
 * is available; top-level pages still use their static collection label.
 *
 * Implementation note: read and write live in *separate* contexts. If
 * we put `{title, setTitle}` in one object, every render of the provider
 * makes a new object identity — useEffect's deps change on every render,
 * the cleanup fires, and the title flickers to null between renders.
 * Splitting the contexts means the setter is stable (useState setters
 * always are), so the effect only re-runs when the *title input* changes.
 */

export type BreadcrumbSegmentContext = "workspace";
export type BreadcrumbSegmentTitle = {
	title: string;
	context?: BreadcrumbSegmentContext;
};
export type BreadcrumbSegmentTitles = Record<string, BreadcrumbSegmentTitle>;
type BreadcrumbTitleRegistration = { routeKey: string; title: string } | null;
type RegisteredBreadcrumbSegmentTitle = BreadcrumbSegmentTitle & { routeKey: string };
type RegisteredBreadcrumbSegmentTitles = Record<string, RegisteredBreadcrumbSegmentTitle>;

const TitleContext = createContext<BreadcrumbTitleRegistration>(null);
const SegmentTitlesContext = createContext<RegisteredBreadcrumbSegmentTitles>({});
const SetTitleContext = createContext<Dispatch<SetStateAction<BreadcrumbTitleRegistration>>>(
	() => {},
);
type SegmentTitleSetter = (
	href: string | null | undefined,
	title: string | null,
	context?: BreadcrumbSegmentContext,
	routeKey?: string,
) => void;
const SetSegmentTitleContext = createContext<SegmentTitleSetter>(() => {});

export function BreadcrumbTitleProvider({ children }: { children: React.ReactNode }) {
	const [title, setTitle] = useState<BreadcrumbTitleRegistration>(null);
	const [segmentTitles, setSegmentTitles] = useState<RegisteredBreadcrumbSegmentTitles>({});
	const setSegmentTitle = useCallback<SegmentTitleSetter>((href, nextTitle, context, routeKey) => {
		const normalizedHref = normalizeBreadcrumbHref(href);
		if (!normalizedHref || !routeKey) return;
		setSegmentTitles((current) => {
			const trimmed = nextTitle?.trim() || null;
			if (!trimmed) {
				if (current[normalizedHref]?.routeKey !== routeKey) return current;
				const { [normalizedHref]: _removed, ...rest } = current;
				return rest;
			}
			const next: RegisteredBreadcrumbSegmentTitle = {
				title: trimmed,
				...(context ? { context } : {}),
				routeKey,
			};
			if (
				current[normalizedHref]?.title === next.title &&
				current[normalizedHref]?.context === next.context &&
				current[normalizedHref]?.routeKey === next.routeKey
			) {
				return current;
			}
			return { ...current, [normalizedHref]: next };
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
	const routeKey = useBreadcrumbRouteKey();
	const registration = useContext(TitleContext);
	return registration?.routeKey === routeKey ? registration.title : null;
}

export function useBreadcrumbSegmentTitles(): BreadcrumbSegmentTitles {
	const routeKey = useBreadcrumbRouteKey();
	const registrations = useContext(SegmentTitlesContext);
	return useMemo(
		() =>
			Object.fromEntries(
				Object.entries(registrations)
					.filter(([, registration]) => registration.routeKey === routeKey)
					.map(([href, { title, context }]) => [href, { title, ...(context ? { context } : {}) }]),
			),
		[registrations, routeKey],
	);
}

/**
 * Detail pages call this with their human-readable title. Pass `null`
 * (or wait until data is ready) to keep the stable loading placeholder.
 *
 * Safe to call unconditionally — if `title` is null/undefined the effect
 * still runs but with no-op semantics. **Call this BEFORE any conditional
 * early-return**; React requires hook order to be stable across renders.
 */
export function useSetBreadcrumbTitle(title: string | null | undefined) {
	const setTitle = useContext(SetTitleContext);
	const routeKey = useBreadcrumbRouteKey();
	useIsomorphicLayoutEffect(() => {
		const trimmed = title?.trim() || null;
		setTitle((current) =>
			trimmed ? { routeKey, title: trimmed } : current?.routeKey === routeKey ? null : current,
		);
		if (!trimmed || typeof document === "undefined") {
			return () => {
				setTitle((current) => (current?.routeKey === routeKey ? null : current));
			};
		}

		const previousTitle = document.title || APP_TITLE;
		const nextTitle = formatDocumentTitle(trimmed);
		document.title = nextTitle;
		return () => {
			setTitle((current) =>
				current?.routeKey === routeKey && current.title === trimmed ? null : current,
			);
			if (document.title === nextTitle) {
				document.title = previousTitle || APP_TITLE;
			}
		};
	}, [routeKey, setTitle, title]);
}

export function useSetBreadcrumbSegmentTitle(
	href: string | null | undefined,
	title: string | null | undefined,
	context?: BreadcrumbSegmentContext,
) {
	const setSegmentTitle = useContext(SetSegmentTitleContext);
	const routeKey = useBreadcrumbRouteKey();
	useIsomorphicLayoutEffect(() => {
		setSegmentTitle(href, title?.trim() || null, context, routeKey);
		return () => setSegmentTitle(href, null, undefined, routeKey);
	}, [context, href, routeKey, setSegmentTitle, title]);
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

function useBreadcrumbRouteKey() {
	return useLocation({
		select: (location) => `${location.pathname}${location.searchStr}`,
	});
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
