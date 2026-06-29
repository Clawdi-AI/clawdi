import { Toaster } from "@/components/ui/sonner";

type Viewport = {
	width: string;
	initialScale: number;
};

/**
 * Explicit viewport for the public share routes. Without `initial-scale=1`,
 * iOS Safari can apply its own zoom-fit heuristics, which throws off the
 * Tailwind breakpoints we rely on for the mobile layout under `/s/*`.
 */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
};

/**
 * Share-route layout — exists solely to mount `<Toaster />`. The
 * top-level `app/layout.tsx` is auth/provider-shell only; the dashboard
 * group mounts its own Toaster, so client interactions outside that
 * group (notably the public share page's copy-URL controls) need their
 * own mount, otherwise `toast.*()` calls silently no-op.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
	return (
		<>
			{children}
			<Toaster />
		</>
	);
}
