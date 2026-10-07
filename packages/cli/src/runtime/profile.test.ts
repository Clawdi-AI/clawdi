import { afterEach, expect, spyOn, test } from "bun:test";
import { profileRuntimeStep, profileRuntimeStepAsync } from "./profile";

const original = process.env.CLAWDI_RUNTIME_PROFILE;
afterEach(() => {
	if (original === undefined) delete process.env.CLAWDI_RUNTIME_PROFILE;
	else process.env.CLAWDI_RUNTIME_PROFILE = original;
});

test("profiling is opt-in and preserves returns and failures without error payloads", async () => {
	const output = spyOn(console, "error").mockImplementation(() => {});
	try {
		delete process.env.CLAWDI_RUNTIME_PROFILE;
		expect(profileRuntimeStep("disabled", () => 42)).toBe(42);
		expect(output).not.toHaveBeenCalled();
		process.env.CLAWDI_RUNTIME_PROFILE = "1";
		const failure = new Error("private credential content");
		await expect(
			profileRuntimeStepAsync("step.failure", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(output).toHaveBeenCalledTimes(1);
		const text = String(output.mock.calls[0]?.[0]);
		expect(text).not.toContain(failure.message);
		const record = JSON.parse(text.slice("CLAWDI_RUNTIME_SPAN ".length));
		expect(Object.keys(record).sort()).toEqual(["durationMs", "label", "pid", "startedAt"]);
		expect(record.label).toBe("step.failure");
		expect(record.durationMs).toBeGreaterThanOrEqual(0);
	} finally {
		output.mockRestore();
	}
});
