import { expect, test } from "bun:test";
import { ApiError } from "@/lib/api-errors";
import {
	isReverificationHint,
	type ReverificationHint,
	settleReverifiedRequest,
	unwrapReverifiable,
} from "@/lib/reverification";

// The 403 body the API returns for `require_reverified_web_auth`.
const hint = {
	clerk_error: {
		type: "forbidden",
		reason: "reverification-error",
		metadata: { reverification: "strict" },
	},
} satisfies ReverificationHint;

const response = new Response(null, { status: 403 });

/** Mirrors Clerk's handler: on the hint, wait for the user, then retry once. */
function clerkHandler<T>(
	request: () => Promise<T | ReverificationHint>,
	verify: () => Promise<void>,
): Promise<T | ReverificationHint> {
	return request().then(async (result) => {
		if (!isReverificationHint(result)) return result;
		await verify();
		return request();
	});
}

/** Clerk recognizes its runtime errors by the constructor's `kind`. */
class ClerkRuntimeError extends Error {
	static kind = "ClerkRuntimeError";
	clerkError = true;
	code = "reverification_cancelled";
}

test("recognizes only Clerk's reverification hint", () => {
	expect(isReverificationHint(hint)).toBe(true);
	expect(isReverificationHint({ detail: "Forbidden" })).toBe(false);
	expect(isReverificationHint({ clerk_error: { type: "forbidden", reason: "other" } })).toBe(false);
	expect(isReverificationHint(null)).toBe(false);
});

test("returns the hint for Clerk and unwraps everything else", () => {
	expect(unwrapReverifiable({ error: hint, response })).toBe(hint);
	expect(unwrapReverifiable({ data: [1], response: new Response() })).toEqual([1]);
	expect(() => unwrapReverifiable({ error: { detail: "Nope" }, response })).toThrow(ApiError);
});

test("retries after the user verifies", async () => {
	const results: Array<string[] | ReverificationHint> = [hint, ["key"]];
	let verifications = 0;
	const keys = await settleReverifiedRequest(
		clerkHandler(
			async () => results.shift() ?? [],
			async () => {
				verifications += 1;
			},
		),
	);
	expect(keys).toEqual(["key"]);
	expect(verifications).toBe(1);
});

test("rejects with a 403 when verification is canceled or still required", async () => {
	const canceled = settleReverifiedRequest(
		clerkHandler(
			async () => hint,
			async () => {
				throw new ClerkRuntimeError("User cancelled attempted verification");
			},
		),
	);
	await expect(canceled).rejects.toMatchObject({ status: 403, code: "reverification_required" });

	const stillRequired = settleReverifiedRequest(
		clerkHandler(
			async () => hint,
			async () => {},
		),
	);
	await expect(stillRequired).rejects.toMatchObject({
		status: 403,
		detail: "Verify your identity to continue.",
	});
});
