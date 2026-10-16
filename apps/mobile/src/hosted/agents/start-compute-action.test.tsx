import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { hostedDeploymentFixture } from "../../../../../packages/shared/src/view/hosted-deployment.test-fixture";

// React Native cannot load under Bun: capture the rendered control instead.
type Control = { label: string; disabled?: boolean; onPress: () => void };
const controls: Control[] = [];
const pushes: unknown[] = [];
mock.module("react-native", () => ({ Linking: { openURL: async () => undefined } }));
mock.module("expo-router", () => ({ router: { push: (href: unknown) => pushes.push(href) } }));
mock.module("@/components/dashboard/controls", () => ({
	ActionButton: (props: Control) => {
		controls.push(props);
		return null;
	},
}));
mock.module("@/components/ui/text", () => ({ Text: () => null }));
mock.module("@/hosted/agents/deployment-controls", () => ({ DeploymentControls: () => null }));
mock.module("@/hosted/billing/store/add-credits", () => ({ AddCreditsAction: () => null }));
mock.module("@/lib/i18n", () => ({ useI18n: () => (key: string) => key }));
mock.module("@/platform/account-lifecycle", () => ({
	useAccountScope: () => ({ identity: {} }),
}));
mock.module("@/platform/auth/use-auth-action", () => ({
	useAuthAction: () => ({ busy: false, error: false, run: async () => undefined }),
}));
mock.module("@/platform/store/store-provider", () => ({
	useStoreSurfaces: () => ({ cardBilling: true, addCredits: false }),
}));

const { StartComputeAction } = await import("./start-compute-action");

test('"Subscribe to start" opens the subscription sheet, including from Settings', () => {
	const deployment = hostedDeploymentFixture({
		id: "hdep_stopped",
		agentId: "4e2e5000-0005-4c00-8000-000000000005",
		status: "stopped",
		desiredLifecycle: "stopped",
		startAction: "subscribe",
	});
	renderToStaticMarkup(
		<StartComputeAction
			deployment={deployment}
			blocked={false}
			transitioning={false}
			onAccepted={async () => undefined}
			onAbsent={async () => undefined}
			onFunded={() => undefined}
		/>,
	);
	const control = controls.at(-1);
	expect(control?.label).toBe("Subscribe to start");
	expect(control?.disabled).toBe(false);
	control?.onPress();
	expect(pushes).toEqual([
		{
			pathname: "/agents/[id]/subscription",
			params: { id: "4e2e5000-0005-4c00-8000-000000000005" },
		},
	]);
});
