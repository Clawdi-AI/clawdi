import { Toaster } from "@/components/ui/sonner";

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
