import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

const agentDetail = source("../../agents/hosted-agent-detail.tsx");
const linkedChannelRow = agentDetail.slice(
	agentDetail.indexOf("function LinkedChannelRow"),
	agentDetail.indexOf("// ── Settings / Compute"),
);
const channelsHooks = source("./channels-hooks.ts");
const channelCard = source("./channel-card.tsx");
const pairedChatsDialog = source("./paired-chats-dialog.tsx");
const queryCache = source("./channel-query-cache.ts");
const queryGuide = source("../../../../../../docs/openapi-react-query.md");

describe("Telegram and Discord channel convergence contract", () => {
	test("keeps Pair exact and paired chats as the only clickable relationship badge", () => {
		expect(linkedChannelRow).toContain('{creatingPairCode ? "Generating…" : "Pair"}');
		expect(linkedChannelRow).not.toContain("Pair Telegram");
		expect(linkedChannelRow).not.toContain("Pair Discord");
		expect(linkedChannelRow).toContain("pairedChatsControl");
		expect(linkedChannelRow).not.toContain("pairedChatCount");
		expect(pairedChatsDialog).toContain("data-agent-paired-chats-trigger={linkId}");
		expect(pairedChatsDialog).toContain("<DialogTrigger render={trigger} />");
		expect(pairedChatsDialog).toContain("<SheetTrigger render={trigger} />");
	});

	test("uses one header-only shared card without a footer action region", () => {
		expect(channelCard).toContain("data-channel-card-header");
		expect(channelCard).toContain("data-channel-card-actions");
		expect(channelCard).not.toContain("data-channel-card-footer");
		expect(channelCard).not.toContain("<footer");
	});

	test("keeps cached bindings visible during background polling", () => {
		expect(agentDetail).toContain("bindingsLoading={Boolean(bindingQuery?.isPending)}");
		expect(agentDetail).not.toContain("bindingsLoading={Boolean(bindingQuery?.isFetching)}");
		expect(agentDetail).toContain("bindingQuery?.error && bindingQuery.data === undefined");
		expect(pairedChatsDialog).toContain("bindingsLoading && pairedChats.length === 0");
	});

	test("uses generated OpenAPI React Query operations and documents sensitive exceptions", () => {
		for (const operation of [
			'return useOpenApi().useQuery("get", "/v1/channels")',
			'return useOpenApi().useQuery("get", "/v1/channels/bot-pool")',
			'api.useMutation("delete", "/v1/channels/{account_id}/bindings/{binding_id}"',
		]) {
			expect(channelsHooks).toContain(operation);
		}
		expect(channelsHooks).toContain("api.queryOptions(");
		expect(channelsHooks).toContain("return useSensitiveAction(async (vars:");
		expect(queryGuide).toContain("channel link/pair workflows");
		expect(queryGuide).toContain("remove secret material before QueryCache");
		expect(queryCache).toContain('"/v1/channels/{account_id}/bindings"');
		expect(queryCache).not.toContain('["channel-bindings"');
	});
});
