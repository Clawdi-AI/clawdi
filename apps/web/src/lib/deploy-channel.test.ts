import { describe, expect, test } from "bun:test";
import { deployChannelAuthSearch, resolveDeployChannel } from "./deploy-channel";

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
	test("keeps explicit invalid values authoritative and parses only one return level", () => {
		for (const search of [
			"deploy_profile=unknown&utm_source=sui",
			"deploy_profile=sui&deploy_profile=sui",
			"utm_source=sui&utm_source=sui",
		]) {
			expect(
				resolveDeployChannel(`?${search}&redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui`),
			).toBeNull();
			expect(
				resolveDeployChannel(`?redirect_url=${encodeURIComponent(`/deploy?${search}`)}`),
			).toBeNull();
		}
		expect(
			resolveDeployChannel("?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui&redirect_url=%2F"),
		).toBeNull();
		expect(
			resolveDeployChannel(
				`?redirect_url=${encodeURIComponent("/sign-in?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui")}`,
			),
		).toBeNull();
	});
});

test("normalizes direct auth entries", () => {
	expect(resolveDeployChannel("?deploy_profile=sui&deploy_profile=sui")).toBeNull();
	expect(deployChannelAuthSearch("?deploy_profile=sui")).toBe(
		"?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui",
	);
	expect(deployChannelAuthSearch("?deploy_profile=sui&redirect_url=https://evil.test")).toBe(
		"?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui",
	);
	expect(deployChannelAuthSearch("?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui")).toBeNull();
});
