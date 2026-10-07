import * as Sentry from "@sentry/react-native";
import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";
import { scrubMobileBreadcrumb, scrubMobileEvent } from "./observability-scrubber";

const configuredDsn: unknown = Constants.expoConfig?.extra?.clawdi?.sentryDsn;
const dsn = typeof configuredDsn === "string" ? configuredDsn.trim() : "";
const environment = process.env.EXPO_PUBLIC_CLAWDI_ENV;
let pathname = "";

export const navigationIntegration = dsn
	? Sentry.reactNavigationIntegration({
			enableTimeToInitialDisplay: !isRunningInExpoGo(),
		})
	: null;

if (navigationIntegration) {
	Sentry.init({
		dsn,
		...(environment ? { environment } : {}),
		sendDefaultPii: false,
		tracesSampleRate: 0.1,
		integrations: [navigationIntegration],
		enableNativeFramesTracking: !isRunningInExpoGo(),
		beforeSend: (event) => scrubMobileEvent(event, pathname),
		beforeSendTransaction: (event) => scrubMobileEvent(event, pathname),
		beforeBreadcrumb: (breadcrumb) => scrubMobileBreadcrumb(breadcrumb, pathname),
	});
}

export function setObservabilityPathname(value: string) {
	pathname = value;
}

export function reportRootError(error: Error, currentPathname: string) {
	if (!dsn) return;
	setObservabilityPathname(currentPathname);
	Sentry.captureException(error);
}

export const wrapRootLayout: typeof Sentry.wrap = dsn ? Sentry.wrap : (component) => component;
