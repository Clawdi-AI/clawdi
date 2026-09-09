import { describe, expect, test } from "bun:test";
import { resolveDeployChannel } from "./deploy-channel";

describe("deployment channel links", () => {
	test("accepts direct and authentication return links", () => {
		expect(resolveDeployChannel("?deploy_profile=sui")).toBe("sui");
		expect(resolveDeployChannel("?utm_source=sui")).toBe("sui");
		expect(resolveDeployChannel("?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui")).toBe("sui");
	});
	test("ignores unknown channels and unsafe return URLs", () => {
		for (const redirect of [
			"//[",
			"//evil.test/?utm_source=sui",
			"/\\evil.test/?utm_source=sui",
			"https://evil.test/?utm_source=sui",
		]) {
			expect(resolveDeployChannel(`?redirect_url=${encodeURIComponent(redirect)}`)).toBeNull();
		}
		expect(resolveDeployChannel("?deploy_profile=unknown&utm_source=sui")).toBeNull();
		expect(resolveDeployChannel("")).toBeNull();
	});
});
