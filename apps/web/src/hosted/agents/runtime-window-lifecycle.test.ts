import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	clearTrackedRuntimeWindowsForTests,
	consumeHermesRuntimeWindowLaunch,
	launchHermesRuntimeWindow,
	retireRuntimeWindows,
	runtimeWindowRetirementUrl,
	trackRuntimeWindow,
} from "@/hosted/agents/runtime-window-lifecycle";

function trackedWindow() {
	return {
		closed: false,
		close: mock(() => {}),
		location: { replace: mock((_url: string | URL) => {}) },
		sessionStorage: { setItem: mock((_key: string, _value: string) => {}) },
	};
}

beforeEach(clearTrackedRuntimeWindowsForTests);

describe("runtime window lifecycle", () => {
	test("moves every matching pre-restart window to an honest Clawdi-owned exit", () => {
		const first = trackedWindow();
		const second = trackedWindow();
		const otherAgent = trackedWindow();
		trackRuntimeWindow("deployment-1", first);
		trackRuntimeWindow("deployment-1", second);
		trackRuntimeWindow("deployment-2", otherAgent);

		retireRuntimeWindows("deployment-1", "restarted", "https://app.clawdi.test");

		const expected = "https://app.clawdi.test/runtime-window?reason=restarted";
		expect(first.location.replace).toHaveBeenCalledWith(expected);
		expect(second.location.replace).toHaveBeenCalledWith(expected);
		expect(otherAgent.location.replace).not.toHaveBeenCalled();
	});

	test("uses a distinct removal state and never puts a deployment id in the URL", () => {
		const popup = trackedWindow();
		trackRuntimeWindow("internal-deployment-id", popup);

		retireRuntimeWindows("internal-deployment-id", "deleting", "https://app.clawdi.test");

		const target = popup.location.replace.mock.calls[0]?.[0];
		expect(target).toBe("https://app.clawdi.test/runtime-window?reason=deleting");
		expect(String(target)).not.toContain("internal-deployment-id");
	});

	test("builds only validated lifecycle destinations", () => {
		expect(runtimeWindowRetirementUrl("https://app.clawdi.test/base", "restarted")).toBe(
			"https://app.clawdi.test/runtime-window?reason=restarted",
		);
	});

	test("opens Hermes inside a Clawdi-owned shell without putting launch data in its URL", () => {
		const popup = trackedWindow();
		expect(
			launchHermesRuntimeWindow(
				"internal-deployment-id",
				"https://runtime.example/hermes",
				popup,
				"https://app.clawdi.test",
			),
		).toBe(true);

		expect(popup.location.replace).toHaveBeenCalledWith(
			new URL("https://app.clawdi.test/runtime-window"),
		);
		expect(String(popup.location.replace.mock.calls[0]?.[0])).not.toContain(
			"internal-deployment-id",
		);
		expect(String(popup.location.replace.mock.calls[0]?.[0])).not.toContain("runtime.example");
	});

	test("consumes and validates the one-time Hermes shell handoff", () => {
		const removeItem = mock((_key: string) => {});
		const storage = {
			getItem: mock(() =>
				JSON.stringify({
					url: "https://runtime.example/hermes",
				}),
			),
			removeItem,
		};

		expect(consumeHermesRuntimeWindowLaunch(storage)).toEqual({
			url: "https://runtime.example/hermes",
		});
		expect(removeItem).toHaveBeenCalledTimes(1);
	});
});
