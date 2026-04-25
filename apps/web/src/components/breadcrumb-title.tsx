"use client";

import { createContext, useContext, useEffect, useState } from "react";

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

const TitleContext = createContext<string | null>(null);
type Setter = (t: string | null) => void;
const SetTitleContext = createContext<Setter>(() => {});

export function BreadcrumbTitleProvider({ children }: { children: React.ReactNode }) {
	const [title, setTitle] = useState<string | null>(null);
	return (
		<TitleContext.Provider value={title}>
			<SetTitleContext.Provider value={setTitle}>{children}</SetTitleContext.Provider>
		</TitleContext.Provider>
	);
}

/** Read-only accessor for the breadcrumb component itself. */
export function useBreadcrumbTitle(): string | null {
	return useContext(TitleContext);
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
