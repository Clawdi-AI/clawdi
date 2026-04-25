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
 */

type Ctx = {
	title: string | null;
	setTitle: (t: string | null) => void;
};

const BreadcrumbTitleContext = createContext<Ctx | null>(null);

export function BreadcrumbTitleProvider({ children }: { children: React.ReactNode }) {
	const [title, setTitle] = useState<string | null>(null);
	return (
		<BreadcrumbTitleContext.Provider value={{ title, setTitle }}>
			{children}
		</BreadcrumbTitleContext.Provider>
	);
}

/** Read-only accessor for the breadcrumb component itself. */
export function useBreadcrumbTitle(): string | null {
	return useContext(BreadcrumbTitleContext)?.title ?? null;
}

/**
 * Detail pages call this with their human-readable title. Pass `null`
 * (or wait until data is ready) to fall back to the URL segment.
 *
 * The cleanup on unmount means navigating away clears the override — the
 * next page sees the URL-derived label until it sets its own.
 */
export function useSetBreadcrumbTitle(title: string | null | undefined) {
	const ctx = useContext(BreadcrumbTitleContext);
	useEffect(() => {
		if (!ctx) return;
		ctx.setTitle(title?.trim() || null);
		return () => ctx.setTitle(null);
	}, [ctx, title]);
}
