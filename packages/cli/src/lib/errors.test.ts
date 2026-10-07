import { describe, expect, test } from "bun:test";
import { isAuthorizationRequired, mapHttpError } from "./errors";
import { HostedDeployApiError } from "./hosted-deploy-client";

describe("HTTP authorization mapping", () => {
	test.each([
		{
			status: 401,
			exitCode: 4,
			message: "CLI authorization was rejected. Run `clawdi auth login`, then try again.",
		},
		{
			status: 403,
			exitCode: 1,
			message: "You don't have permission to perform this action from the CLI. Use the dashboard.",
		},
	])("maps HTTP $status consistently", ({ status, exitCode, message }) => {
		const mapped = mapHttpError({ status }, "Hosted Deploy");
		expect(mapped).toEqual({
			code: status === 401 ? "hosted_deploy_auth_required" : "hosted_deploy_forbidden",
			message,
			exitCode,
		});
	});

	test("classifies HostedDeployApiError by status rather than response text", () => {
		expect(isAuthorizationRequired(new HostedDeployApiError(401, "permission granted"))).toBe(true);
		expect(isAuthorizationRequired(new HostedDeployApiError(403, "sign in again"))).toBe(false);
	});
});
