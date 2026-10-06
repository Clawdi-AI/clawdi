import { useClerk } from "@clerk/expo";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { useAppearance } from "@/platform/appearance-provider";

// Must run at module scope, before the first render, or the splash may already be gone.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export function HideSplash({ ready }: { ready: boolean }) {
	useEffect(() => {
		if (ready) SplashScreen.hide();
	}, [ready]);
	return null;
}

/** Keeps the themed native splash until the stored appearance is applied. */
export function AppSplash() {
	const appearance = useAppearance();
	return <HideSplash ready={appearance.ready || appearance.error} />;
}

/** Also waits for Clerk to settle (`ready`, `degraded`, or `error`) so auth routes never flash. */
export function ClerkAppSplash() {
	const appearance = useAppearance();
	const { status } = useClerk();
	return <HideSplash ready={(appearance.ready || appearance.error) && status !== "loading"} />;
}
