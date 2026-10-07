import { describe, expect, test } from "bun:test";
import { isAuthorizationRequired, mapHttpError } from "./errors";
import { HostedDeployApiError } from "./hosted-deploy-client";

describe("HTTP authorization mapping", () => {
	test.each([
		{
			status: 401,
			code: undefined,
			exitCode: 4,
			message: "CLI authorization was rejected. Run `clawdi auth login`, then try again.",
		},
		{
			status: 403,
			code: undefined,
			exitCode: 1,
			message: "You don't have permission to perform this action from the CLI. Use the dashboard.",
		},
		{
			status: 0,
			code: "hosted_token_expired",
			exitCode: 4,
			message: "CLI authorization was rejected. Run `clawdi auth login`, then try again.",
		},
		{
			status: 0,
			code: "invalid_hosted_token",
			exitCode: 4,
			message: "CLI authorization was rejected. Run `clawdi auth login`, then try again.",
		},
	])("maps status and auth codes consistently", ({ status, code, exitCode, message }) => {
		const mapped = mapHttpError({ status, code }, "Hosted Deploy");
		expect(mapped).toEqual({
			code: exitCode === 4 ? "hosted_deploy_auth_required" : "hosted_deploy_forbidden",
			message,
			exitCode,
		});
	});

	test("classifies HostedDeployApiError by status rather than response text", () => {
		expect(isAuthorizationRequired(new HostedDeployApiError(401, "permission granted"))).toBe(true);
		expect(isAuthorizationRequired(new HostedDeployApiError(403, "sign in again"))).toBe(false);
	});
});
