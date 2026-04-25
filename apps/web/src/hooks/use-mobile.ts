import * as React from "react";

// Why 1024 (Tailwind `lg`), not 768: the sidebar takes ~256 px of horizontal
// real estate. The dashboard's 2-col grid (`lg:grid-cols-3`) needs the same
// 1024 px breakpoint to switch between stacked and side-by-side. Keep the
// sidebar's collapse breakpoint aligned with the layout grid; otherwise at
// 768–1023 the sidebar stays open AND the grid is single-column, leaving
// ~500 px for content and overflowing every card on the right.
const MOBILE_BREAKPOINT = 1024;

export function useIsMobile() {
	const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

	React.useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
		const onChange = () => {
			setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
		};
		mql.addEventListener("change", onChange);
		setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	return !!isMobile;
}
