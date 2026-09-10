import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { observeSessionContent, parseContentVersion } from "./session-content-events";
import { sessionDetailQueryKey } from "./session-queries";

const empty = {
	has_content: false,
	content_hash: "a",
	content_protocol: "snapshot-v1",
	event_head_hash: null,
} as const;
const uploaded = { ...empty, has_content: true };

test("upload during initial detail request converges once, without fetching old message pages", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const key = sessionDetailQueryKey("session");
	const initial = Promise.withResolvers<typeof empty>();
	const refreshed = Promise.withResolvers<void>();
	let requests = 0;
	const query = new QueryObserver(client, {
		queryKey: key,
		queryFn: () => {
			requests++;
			return requests === 1 ? initial.promise : Promise.resolve(uploaded);
		},
	});
	const unsubscribe = query.subscribe((result) => {
		if (result.data?.has_content) refreshed.resolve();
	});
	const content = observeSessionContent(client, "session");
	client.setQueryData(["session-messages", "session", "old"], "cached old pages");
	try {
		content.receive(uploaded);
		expect(requests).toBe(1);
		initial.resolve(empty);
		await refreshed.promise;
		expect(requests).toBe(2);
		content.receive(uploaded);
		content.receive(uploaded);
		expect(requests).toBe(2);
		expect(client.getQueryState(["session-messages", "session", "old"])?.isInvalidated).toBe(false);
		content.dispose();
		content.receive(empty);
		expect(requests).toBe(2);
	} finally {
		content.dispose();
		unsubscribe();
		client.clear();
	}
});

test("stream rejects malformed versions and distinguishes metadata from uploaded content", () => {
	expect(parseContentVersion(JSON.stringify(empty))).toEqual(empty);
	expect(parseContentVersion(JSON.stringify(uploaded))).toEqual(uploaded);
	expect(parseContentVersion('{"has_content":true}')).toBeNull();
	expect(parseContentVersion("null")).toBeNull();
});
