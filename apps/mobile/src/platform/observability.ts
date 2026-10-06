import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import { scrubMobileBreadcrumb, scrubMobileEvent } from "./observability-scrubber";

const configuredDsn: unknown = Constants.expoConfig?.extra?.clawdi?.sentryDsn;
const dsn = typeof configuredDsn === "string" ? configuredDsn.trim() : "";
let pathname = "";

if (dsn) {
	Sentry.init({
		dsn,
		environment: process.env.EXPO_PUBLIC_CLAWDI_ENV,
		sendDefaultPii: false,
		tracesSampleRate: 0.1,
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
