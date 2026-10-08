/** Web recipes for the first-start screen; shared with native wrappers. */
export const initialDeploymentClasses = {
	/** Holds the real overview behind a glass layer with the setup status above it. */
	stage: "relative",
	/**
	 * The overview itself is never filtered, so revealing it never re-rasterizes it.
	 * Its clipped bottom fades into the page, so no cut edge shows under the glass.
	 */
	preview:
		"pointer-events-none max-h-[calc(100svh-8rem)] overflow-hidden select-none [mask-image:linear-gradient(to_bottom,black_calc(100%-8rem),transparent)]",
	/**
	 * One reveal timeline: the overlay (glass, scrim, status) fades as a single layer,
	 * so only opacity and transform animate.
	 */
	overlay:
		"pointer-events-none absolute inset-0 z-10 transition-opacity duration-[900ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
	overlayLeaving: "opacity-0",
	/**
	 * A light backdrop blur and tint keep the overview recognizable behind the status.
	 * It reaches past the content column to the page padding and under the header, so
	 * its edges fall on plain background or the panel's own rounded clip.
	 */
	glass: "absolute -inset-x-4 -top-5 -bottom-4 bg-background/20 backdrop-blur-[3px] lg:-inset-x-6",
	/**
	 * Centers the module in the visible main area below the sticky header: the stage
	 * starts after the page's top padding, and the desktop panel sits inside a margin.
	 */
	position:
		"absolute inset-x-0 top-[calc((100svh-var(--header-height))/2-1rem)] flex justify-center transition-transform duration-[900ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none md:top-[calc((100svh-1rem-var(--header-height))/2-1.25rem)]",
	positionLeaving: "translate-y-1 scale-[0.98]",
	/** The whole module lives in one true circle; `circleFill` paints its soft backdrop. */
	content:
		"pointer-events-auto relative isolate flex aspect-square w-[clamp(18rem,88vw,24rem)] -translate-y-1/2 flex-col items-center justify-center rounded-full px-10 text-center",
	/**
	 * The circle's backdrop reaches past the module so its long falloff has room to
	 * fade out; its radial stops come from `initialDeploymentCircleStops`.
	 */
	circleFill: "pointer-events-none absolute -inset-[30%] -z-10 rounded-full",
	/** Sidebar items that become available fade from their muted state on the same curve. */
	navReveal:
		"animate-in fade-in-50 duration-[900ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:animate-none",
	hero: "relative flex size-16 items-center justify-center",
	halo: "absolute inset-1 rounded-full bg-primary/20 animate-launch-halo motion-reduce:hidden",
	haloDelayed: "[animation-delay:1.2s]",
	/** A subtle circular ring around the standard circular agent avatar. */
	frame: "relative rounded-full bg-card p-1 shadow-sm ring-1",
	frameTone: {
		progress: "ring-primary/30",
		delayed: "ring-warning/50",
		stuck: "ring-warning/50",
		ready: "ring-success/50",
		failed: "ring-destructive/40",
	},
	/** Standard avatar badge placement on the circle's bottom-right. */
	badge:
		"absolute right-0 bottom-0 flex size-5 items-center justify-center rounded-full ring-2 ring-background [&>svg]:size-3",
	badgeTone: {
		ready:
			"bg-success text-success-foreground animate-in fade-in-0 zoom-in-50 duration-300 motion-reduce:animate-none",
		delayed: "bg-warning text-warning-foreground",
		stuck: "bg-warning text-warning-foreground",
		failed: "bg-destructive text-white",
	},
	statusLine: "mt-4 flex max-w-[16rem] flex-col items-center gap-0.5",
	status: "text-base font-medium text-balance text-foreground",
	statusTone: {
		progress: "",
		delayed: "text-warning-muted-foreground",
		stuck: "text-warning-muted-foreground",
		ready: "text-success-muted-foreground",
		failed: "text-destructive",
	},
	statusMeta: "text-sm whitespace-nowrap text-muted-foreground",
	elapsed: "font-mono text-xs tabular-nums text-muted-foreground",
	detail: "mt-1 text-sm text-balance text-muted-foreground",
	actions: "mt-4 flex max-w-[16rem] flex-wrap justify-center gap-2",
	/** Native: the dimmed overview placeholder behind the module. */
	nativePreview: "gap-3 opacity-30",
	nativeOverlay: "absolute inset-0 items-center justify-center",
	/** Native circle; its soft-edged fill is drawn with the same radial stops. */
	nativeCircle: "size-80 items-center justify-center px-10",
	/** Native draws the backdrop on an overflowing layer, as Web does. */
	nativeCircleFill: "absolute -inset-24",
} as const;

/**
 * The circle backdrop: the page background at `centerOpacity`, held to `falloffStart`
 * of the radius and then eased to transparent with smootherstep, which is flat at both
 * ends, so neither the start of the fade nor the outer edge reads as a ring.
 */
export const INITIAL_DEPLOYMENT_CIRCLE = { centerOpacity: 0.55, falloffStart: 0.45 } as const;

export function initialDeploymentCircleStops({
	centerOpacity,
	falloffStart,
}: {
	centerOpacity: number;
	falloffStart: number;
} = INITIAL_DEPLOYMENT_CIRCLE): {
	offset: number;
	opacity: number;
}[] {
	const steps = 8;
	return [
		{ offset: 0, opacity: centerOpacity },
		...Array.from({ length: steps + 1 }, (_, index) => {
			const progress = index / steps;
			const eased = progress ** 3 * (progress * (progress * 6 - 15) + 10);
			return {
				offset: falloffStart + (1 - falloffStart) * progress,
				opacity: centerOpacity * (1 - eased),
			};
		}),
	].map((stop) => ({
		offset: Math.round(stop.offset * 1000) / 1000,
		opacity: Math.round(stop.opacity * 1000) / 1000,
	}));
}
