import { expect, test } from "bun:test";
import { createAppQueryClient } from "@/lib/query-client";

test("clearing the cache aborts requests and rejects late results", async () => {
	const oldClient = createAppQueryClient();
	const deferred = Promise.withResolvers<string>();
	let signal: AbortSignal | undefined;
	const request = oldClient
		.fetchQuery({
			queryKey: ["private"],
			queryFn: (context) => {
				signal = context.signal;
				return deferred.promise;
			},
		})
		.catch(() => undefined);
	try {
		oldClient.clear();
		expect(signal?.aborted).toBe(true);
		deferred.resolve("late-old-user");
		await request;
		expect(oldClient.getQueryData(["private"])).toBeUndefined();
	} finally {
		oldClient.clear();
	}
});
