import { expect, test } from "bun:test";
import { createAppQueryClient } from "@/lib/query-client";

test("retired session requests and callbacks cannot populate the replacement cache", async () => {
	const oldClient = createAppQueryClient();
	const newClient = createAppQueryClient();
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
	oldClient.setQueryData(["cached-destination"], "old-user");
	try {
		oldClient.clear();
		expect(signal?.aborted).toBe(true);
		deferred.resolve("late-old-user");
		await request;
		oldClient.setQueryData(["mutation-callback"], "old-user");
		expect(newClient.getQueryCache().getAll()).toHaveLength(0);
		expect(oldClient.getQueryData(["private"])).toBeUndefined();
	} finally {
		oldClient.clear();
		newClient.clear();
	}
});
