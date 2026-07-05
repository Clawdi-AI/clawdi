import { describe, expect, test } from "bun:test";
import { publicSessionExportErrorMessage } from "./session-export-route";

describe("public session export errors", () => {
	test("maps known public access statuses without leaking backend details", () => {
		expect(publicSessionExportErrorMessage(401)).toBe("Authentication required.");
		expect(publicSessionExportErrorMessage(403)).toBe(
			"You do not have access to this shared session.",
		);
		expect(publicSessionExportErrorMessage(404)).toBe("Not found");
		expect(publicSessionExportErrorMessage(410)).toBe("This shared session link has expired.");
	});

	test("uses generic copy for internal and unknown errors", () => {
		expect(publicSessionExportErrorMessage(500)).toBe(
			"The service is having trouble right now. Please try again in a moment.",
		);
		expect(publicSessionExportErrorMessage(418)).toBe("Unable to export this shared session.");
	});
});
