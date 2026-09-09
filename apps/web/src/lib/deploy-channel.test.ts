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

describe("anonymous deployment intent ownership", () => {
	test("bounds persistence, binds the first account, and merges concurrent claims", async () => {
		const { DeployChannelIntent, DEPLOY_CHANNEL_TTL } = await import("./deploy-channel");
		let stored: string | null = null;
		const storage = {
			getItem: () => stored,
			setItem: (_: string, value: string) => {
				stored = value;
			},
			removeItem: () => {
				stored = null;
			},
		};
		const owner = new DeployChannelIntent(() => storage);
		owner.capture("?deploy_profile=sui", null, 100);
		owner.capture("", "account-a", 101);
		owner.capture("", null, 102);
		expect(owner.getSnapshot().intent?.userId).toBe("account-a");
		let writes = 0;
		const save = async () => {
			writes++;
		};
		await owner.claim("account-b", save);
		expect(writes).toBe(0);
		await Promise.all([owner.claim("account-a", save), owner.claim("account-a", save)]);
		expect(writes).toBe(1);
		expect(stored).toBeNull();
		owner.capture("?deploy_profile=sui", null, 100);
		const restored = new DeployChannelIntent(() => storage);
		restored.capture("", "account-b", 100 + DEPLOY_CHANNEL_TTL);
		expect(restored.getSnapshot().intent).toBeNull();
	});

	test("keeps failed claims bound and works in memory when storage is disabled", async () => {
		const { DeployChannelIntent, clearDeployChannelUrl } = await import("./deploy-channel");
		const owner = new DeployChannelIntent(() => {
			throw new Error("disabled");
		});
		owner.capture("?redirect_url=%2Fdeploy%3Fdeploy_profile%3Dsui", "account-a");
		await owner.claim("account-a", async () => {
			throw new Error("offline");
		});
		expect(owner.getSnapshot().error).toBe(true);
		owner.capture("", null);
		expect(owner.getSnapshot().intent?.userId).toBe("account-a");
		await owner.claim("account-a", async () => {});
		expect(owner.getSnapshot().intent).toBeNull();
		owner.capture("?deploy_profile=sui", "account-a");
		const gate = Promise.withResolvers<void>();
		const pending = owner.claim("account-a", async (signal) => {
			await gate.promise;
			expect(signal.aborted).toBe(true);
		});
		await Promise.resolve();
		expect(owner.capture("?deploy_profile=sui", "account-b")).toBe(true);
		gate.resolve();
		await pending;
		expect(owner.getSnapshot().intent).toBeNull();
		expect(clearDeployChannelUrl("/deploy?deploy_profile=sui&view=all#details")).toBe(
			"/deploy?view=all#details",
		);
		expect(resolveDeployChannel("?deploy_profile=sui&deploy_profile=sui")).toBeNull();
	});
});
