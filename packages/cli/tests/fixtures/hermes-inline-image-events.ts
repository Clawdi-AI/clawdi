import { toolResultContent, visibleContentParts } from "../../src/adapters/rich-event-mapping";
import { encodeEventNdjson, sequenceSessionEvents } from "../../src/lib/session-events";
import fixture from "./hermes-inline-image.json";

process.stdout.write(
	encodeEventNdjson(
		sequenceSessionEvents([
			{
				type: "message",
				role: "user",
				parts: visibleContentParts(fixture.content),
				source: { adapter: "hermes", session_key: "synthetic-session", record_id: "1" },
			},
			{
				type: "tool_result",
				call_id: "synthetic-call",
				status: "completed",
				...toolResultContent(fixture.content),
				source: { adapter: "hermes", session_key: "synthetic-session", record_id: "2" },
			},
		]),
	),
);
