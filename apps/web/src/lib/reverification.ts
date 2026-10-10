"use client";

import { useReverification } from "@clerk/tanstack-react-start";
import { isReverificationCancelledError } from "@clerk/tanstack-react-start/errors";
import { useCallback } from "react";
import { unwrap } from "@/lib/api";
import { ApiError } from "@/lib/api-errors";
import { env } from "@/lib/env";

/**
 * Clerk's documented reverification hint, which the API returns as a 403 body
 * when a route requires a recently verified session.
 * https://github.com/clerk/javascript/blob/main/packages/shared/src/authorization-errors.ts
 */
export type ReverificationHint = {
	clerk_error: { type: "forbidden"; reason: "reverification-error"; metadata?: unknown };
};

export function isReverificationHint(value: unknown): value is ReverificationHint {
	if (typeof value !== "object" || value === null) return false;
	const clerkError: unknown = Reflect.get(value, "clerk_error");
	return (
		typeof clerkError === "object" &&
		clerkError !== null &&
		Reflect.get(clerkError, "type") === "forbidden" &&
		Reflect.get(clerkError, "reason") === "reverification-error"
	);
}

/** Like `unwrap`, but returns Clerk's hint so `useReverifiedRequest` can prompt. */
export function unwrapReverifiable<T>(result: {
	data?: T;
	error?: unknown;
	response: Response;
}): T | ReverificationHint {
	return isReverificationHint(result.error) ? result.error : unwrap(result);
}

function reverificationRequired(): ApiError {
	return new ApiError(403, "Verify your identity to continue.", "reverification_required");
}

/** Maps a canceled or still-required verification to a 403 `ApiError`. */
export async function settleReverifiedRequest<T>(
	request: Promise<T | ReverificationHint>,
): Promise<T> {
	let result: T | ReverificationHint;
	try {
		result = await request;
	} catch (error) {
		if (isReverificationCancelledError(error)) throw reverificationRequired();
		throw error;
	}
	if (isReverificationHint(result)) throw reverificationRequired();
	return result;
}

/**
 * Wraps a request with Clerk's `useReverification`: when the API answers with
 * the reverification hint, Clerk prompts the user to verify, then retries once.
 * A canceled or still-required verification rejects with a 403 `ApiError`.
 * https://clerk.com/docs/guides/secure/reverification
 */
export function useReverifiedRequest<Args extends unknown[], T>(
	request: (...args: Args) => Promise<T | ReverificationHint>,
): (...args: Args) => Promise<T> {
	if (env.VITE_DEV_AUTH_BYPASS) {
		// Dev bypass has no Clerk session; the API skips reverification for it too.
		return useCallback((...args: Args) => settleReverifiedRequest(request(...args)), [request]);
	}
	const reverified = useReverification(request);
	return useCallback((...args: Args) => settleReverifiedRequest(reverified(...args)), [reverified]);
}
