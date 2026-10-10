import { beforeEach, expect, mock, test } from "bun:test";
import type { HermesDashboardHandoff } from "@clawdi/shared/api";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hostedDeploymentFixture } from "../../../../../packages/shared/src/view/hosted-deployment.test-fixture";

const dashboard = "https://runtime.example.test/";
const handoff: HermesDashboardHandoff = {
	url: `https://compute.example.test/v2/hermes/oidc/handoff?code=${"A".repeat(43)}`,
	expires_at: "2026-10-10T00:01:00Z",
	deployment_resource_version: "fresh-version",
};

function deployment(runtime: "hermes" | "openclaw" = "hermes", url = dashboard) {
	const common = {
		url,
		role: "control_ui",
		browser_mode: "embedded_and_top_level",
		serving_ready: true,
		serving_reason: "Ok",
	} as const;
	return hostedDeploymentFixture({
		runtime,
		resourceVersion: "reviewed-version",
		runtimeUiEndpoint:
			runtime === "hermes"
				? {
						...common,
						runtime,
						auth_mode: "oidc",
						browser_session_url:
							"https://compute.example.test/v2/deployments/dep_test/hermes-oidc/session",
						access_revision: 1,
					}
				: { ...common, runtime, auth_mode: "openclaw_token" },
	});
}

function harness() {
	const fresh = deployment();
	fresh.resource.metadata.resourceVersion = "fresh-version";
	const state = {
		fresh,
		controller: new AbortController(),
		current: true,
		visible: true,
		active: true,
		busy: false,
		onPress: undefined as (() => void) | undefined,
		confirm: undefined as (() => unknown) | undefined,
		description: "",
		mint: async () => handoff,
	};
	const getDeployment = mock(async (_id: string, _signal?: AbortSignal) => state.fresh);
	const createHermesDashboardHandoff = mock(
		async (_id: string, _version: string, _signal?: AbortSignal) => state.mint(),
	);
	const runtimeCredentials = mock(
		async (_id: string, _version: string, endpoint: string, _signal?: AbortSignal) => ({
			handoff_url: `${endpoint}#bootstrapToken=fixture&bootstrapProfile=owner`,
		}),
	);
	const openBrowserAsync = mock(async (_url: string) => ({ type: "dismiss" }));
	return Object.assign(state, {
		getDeployment,
		createHermesDashboardHandoff,
		runtimeCredentials,
		openBrowserAsync,
	});
}

let h: ReturnType<typeof harness>;
mock.module("expo-web-browser", () => ({
	openBrowserAsync: (url: string) => h.openBrowserAsync(url),
}));
mock.module("lucide-react-native/icons/panels-top-left", () => ({ default: () => null }));
const button = ({ onPress }: { onPress?: () => void }) => {
	h.onPress = onPress;
	return null;
};
mock.module("@/components/dashboard/controls", () => ({ ActionButton: button }));
mock.module("@/components/dashboard/agent-overview-layout", () => ({
	OverviewNavigationCard: button,
}));
mock.module("@/components/ui/text", () => ({
	Text: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module("@/components/ui/use-confirmation", () => ({
	useConfirmation: () => ({
		dialog: null,
		show: (
			_title: string,
			description: string,
			buttons: { style?: string; onPress?: () => unknown }[],
		) => {
			h.description = description;
			h.confirm = buttons.find((item) => item.style !== "cancel")?.onPress;
		},
	}),
}));
mock.module("@/lib/api-provider", () => ({
	useMobileApi: () => ({
		hosted: { getDeployment: h.getDeployment },
		deploymentMutations: {
			createHermesDashboardHandoff: h.createHermesDashboardHandoff,
			runtimeCredentials: h.runtimeCredentials,
		},
	}),
}));
// Bun keeps the first mock's export names for the whole run; other suites import accountQueryKey.
mock.module("@/platform/account-lifecycle", () => ({
	accountQueryKey: (...parts: unknown[]) => parts,
	useAccountScope: () => ({
		identity: "owner",
		signal: h.controller.signal,
		isCurrent: () => h.current,
	}),
	useAccountRead: () => (read: (signal: AbortSignal) => unknown, signal: AbortSignal) =>
		read(signal),
}));
mock.module("@/platform/auth/use-auth-action", () => ({
	useAuthAction: () => ({
		busy: h.busy,
		error: false,
		runOrThrow: (action: (active: () => boolean) => Promise<void>) => action(() => h.active),
	}),
}));
mock.module("@/platform/use-foreground-lease", () => ({
	useForegroundLease: () => () => () => h.visible,
}));

const { RuntimeBrowser } = await import("./runtime-handoff");

beforeEach(() => {
	h = harness();
});

test("Hermes mints only after confirmation and opens the returned Hosted URL in the browser", async () => {
	for (const overview of [false, true]) {
		h = harness();
		renderToStaticMarkup(<RuntimeBrowser deployment={deployment()} overview={overview} />);
		h.onPress?.();
		expect(h.description).toContain(dashboard);
		expect(h.description).not.toContain("?code=");
		expect(h.getDeployment).not.toHaveBeenCalled();
		expect(h.createHermesDashboardHandoff).not.toHaveBeenCalled();
		await h.confirm?.();
		expect(h.getDeployment).toHaveBeenCalledWith("dep_test", h.controller.signal);
		expect(h.createHermesDashboardHandoff).toHaveBeenCalledWith(
			"dep_test",
			"fresh-version",
			h.controller.signal,
		);
		expect(h.openBrowserAsync).toHaveBeenCalledTimes(1);
		expect(h.openBrowserAsync).toHaveBeenCalledWith(handoff.url);
		expect(h.runtimeCredentials).not.toHaveBeenCalled();
	}
});

test("changed deployment identity, dashboard URL or runtime blocks Hermes issuance and browser open", async () => {
	const changedId = deployment();
	changedId.resource.id = "other";
	for (const fresh of [
		changedId,
		deployment("hermes", "https://other.example.test/"),
		deployment("openclaw"),
	]) {
		h = harness();
		h.fresh = fresh;
		renderToStaticMarkup(<RuntimeBrowser deployment={deployment()} />);
		h.onPress?.();
		await expect(Promise.resolve(h.confirm?.())).rejects.toHaveProperty(
			"name",
			"RuntimeEndpointChangedError",
		);
		expect(h.createHermesDashboardHandoff).not.toHaveBeenCalled();
		expect(h.runtimeCredentials).not.toHaveBeenCalled();
		expect(h.openBrowserAsync).not.toHaveBeenCalled();
	}
});

test("retired confirmation cannot read, mint or open", async () => {
	for (const retire of [
		() => h.controller.abort(),
		() => {
			h.current = false;
		},
		() => {
			h.visible = false;
		},
	]) {
		h = harness();
		renderToStaticMarkup(<RuntimeBrowser deployment={deployment()} />);
		h.onPress?.();
		retire();
		await h.confirm?.();
		expect(h.getDeployment).not.toHaveBeenCalled();
		expect(h.createHermesDashboardHandoff).not.toHaveBeenCalled();
		expect(h.openBrowserAsync).not.toHaveBeenCalled();
	}
});

test("late handoff after background or account change never opens the browser", async () => {
	for (const retire of [
		() => {
			h.visible = false;
		},
		() => {
			h.current = false;
		},
		() => {
			h.active = false;
		},
		() => h.controller.abort(),
	]) {
		h = harness();
		let finish: ((handoff: HermesDashboardHandoff) => void) | undefined;
		h.mint = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		renderToStaticMarkup(<RuntimeBrowser deployment={deployment()} />);
		h.onPress?.();
		const pending = h.confirm?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.createHermesDashboardHandoff).toHaveBeenCalledTimes(1);
		retire();
		finish?.(handoff);
		await pending;
		expect(h.openBrowserAsync).not.toHaveBeenCalled();
	}
});

test("OpenClaw keeps its exact runtime credential request and returned browser handoff", async () => {
	h.fresh = deployment("openclaw");
	h.fresh.resource.metadata.resourceVersion = "fresh-version";
	renderToStaticMarkup(<RuntimeBrowser deployment={deployment("openclaw")} />);
	h.onPress?.();
	expect(h.runtimeCredentials).not.toHaveBeenCalled();
	await h.confirm?.();
	expect(h.runtimeCredentials).toHaveBeenCalledTimes(1);
	expect(h.runtimeCredentials).toHaveBeenCalledWith(
		"dep_test",
		"fresh-version",
		dashboard,
		h.controller.signal,
	);
	expect(h.openBrowserAsync).toHaveBeenCalledTimes(1);
	expect(h.openBrowserAsync).toHaveBeenCalledWith(
		`${dashboard}#bootstrapToken=fixture&bootstrapProfile=owner`,
	);
	expect(h.createHermesDashboardHandoff).not.toHaveBeenCalled();
});

test("Hermes mint failure never opens, retries or falls back to runtime credentials", async () => {
	h.mint = async () => {
		throw new Error("Handoff unavailable");
	};
	renderToStaticMarkup(<RuntimeBrowser deployment={deployment()} />);
	h.onPress?.();
	await expect(Promise.resolve(h.confirm?.())).rejects.toThrow("Handoff unavailable");
	expect(h.createHermesDashboardHandoff).toHaveBeenCalledTimes(1);
	expect(h.openBrowserAsync).not.toHaveBeenCalled();
	expect(h.runtimeCredentials).not.toHaveBeenCalled();
});
