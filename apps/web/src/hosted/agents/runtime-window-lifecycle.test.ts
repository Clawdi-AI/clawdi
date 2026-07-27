import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	clearTrackedRuntimeWindowsForTests,
	retireRuntimeWindows,
	trackRuntimeWindow,
} from "@/hosted/agents/runtime-window-lifecycle";

function trackedWindow() {
	return {
		closed: false,
		close: mock(() => {}),
	};
}

beforeEach(clearTrackedRuntimeWindowsForTests);

describe("runtime window lifecycle", () => {
	test("closes every tracked window for the matching deployment", () => {
		const first = trackedWindow();
		const second = trackedWindow();
		const otherAgent = trackedWindow();
		trackRuntimeWindow("deployment-1", first);
		trackRuntimeWindow("deployment-1", second);
		trackRuntimeWindow("deployment-2", otherAgent);

		retireRuntimeWindows("deployment-1");

		expect(first.close).toHaveBeenCalledTimes(1);
		expect(second.close).toHaveBeenCalledTimes(1);
		expect(otherAgent.close).not.toHaveBeenCalled();
	});

	test("drops retired windows even when one browser proxy rejects close", () => {
		const unavailable = {
			closed: false,
			close: mock(() => {
				throw new Error("WindowProxy unavailable");
			}),
		};
		const available = trackedWindow();
		trackRuntimeWindow("deployment-1", unavailable);
		trackRuntimeWindow("deployment-1", available);

		retireRuntimeWindows("deployment-1");
		retireRuntimeWindows("deployment-1");

		expect(unavailable.close).toHaveBeenCalledTimes(1);
		expect(available.close).toHaveBeenCalledTimes(1);
	});
});
