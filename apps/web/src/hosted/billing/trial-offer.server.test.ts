import { describe, expect, it } from "bun:test";
import { receiveTrialOffer } from "./trial-offer.server";

describe("trial offer handoff", () => {
	it("sends dashboard offers to authenticated admission instead of the public root", () => {
		for (const profile of ["", "&deploy_profile=sui"]) {
			const response = receiveTrialOffer(
				new Request(`https://cloud.example/trial-offer?token=opaque&target=dashboard${profile}`),
			);
			expect(response.status).toBe(303);
			expect(response.headers.get("location")).toBe(
				`/dashboard${profile ? "?deploy_profile=sui" : ""}`,
			);
		}
	});

	it("stores an opaque credential without reflecting it into the destination", () => {
		const response = receiveTrialOffer(
			new Request("https://cloud.example/trial-offer?token=opaque_credential&target=sign-in"),
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/sign-in?redirect_url=%2Fdeploy");
		const cookie = response.headers.get("set-cookie") ?? "";
		for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
			expect(cookie).toContain(flag);
		expect(cookie).not.toContain("Domain=");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("rejects duplicate credentials and arbitrary redirect destinations", () => {
		for (const search of [
			"token=a&token=b&target=deploy",
			"token=a&target=deploy&target=sign-in",
			"token=a&target=https://evil.example",
			"token=a&target=__proto__",
			"token=a%0D%0Ainjected&target=deploy",
			"token=a%0A&target=deploy",
			`token=${"a".repeat(513)}&target=deploy`,
		]) {
			const response = receiveTrialOffer(
				new Request(`https://cloud.example/trial-offer?${search}`),
			);
			expect(response.status).toBe(400);
			expect(response.headers.has("set-cookie")).toBe(false);
		}
	});
});

it("preserves a presentation profile through sign-in without granting an offer", () => {
	const response = receiveTrialOffer(
		new Request(
			"https://cloud.example/trial-offer?token=opaque&target=sign-in&deploy_profile=partner",
		),
	);
	const redirect = new URL(response.headers.get("location") ?? "", "https://cloud.example");
	expect(redirect.pathname).toBe("/sign-in");
	expect(redirect.searchParams.get("redirect_url")).toBe("/deploy?deploy_profile=partner");
	for (const profile of ["partner&deploy_profile=another", "%0A", "//evil.example"]) {
		expect(
			receiveTrialOffer(
				new Request(
					`https://cloud.example/trial-offer?token=opaque&target=deploy&deploy_profile=${profile}`,
				),
			).status,
		).toBe(400);
	}
});
