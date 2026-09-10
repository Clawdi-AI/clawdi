export type ServerSentEvent = {
	id: string | null;
	event: string;
	data: string;
};

type ServerSentEventState = {
	data: string[];
	event: string;
	lastEventId: string | null;
};

function dispatchEvent(
	state: ServerSentEventState,
	onEvent: (event: ServerSentEvent) => void,
): void {
	if (state.data.length === 0) return;
	onEvent({ id: state.lastEventId, event: state.event || "message", data: state.data.join("\n") });
	state.data = [];
	state.event = "";
}

function consumeLine(
	line: string,
	state: ServerSentEventState,
	onEvent: (event: ServerSentEvent) => void,
): void {
	if (line === "") {
		dispatchEvent(state, onEvent);
		return;
	}
	if (line.startsWith(":")) return;

	const separator = line.indexOf(":");
	const field = separator === -1 ? line : line.slice(0, separator);
	let value = separator === -1 ? "" : line.slice(separator + 1);
	if (value.startsWith(" ")) value = value.slice(1);

	if (field === "data") state.data.push(value);
	else if (field === "event") state.event = value;
	else if (field === "id" && !value.includes("\0")) state.lastEventId = value;
}

/** Consume a WHATWG SSE stream without assuming network chunk boundaries align to frames. */
export async function consumeServerSentEvents(
	stream: ReadableStream<Uint8Array>,
	onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const state: ServerSentEventState = { data: [], event: "", lastEventId: null };
	let pending = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			pending += decoder.decode(value, { stream: !done });

			let lineStart = 0;
			for (let index = 0; index < pending.length; index += 1) {
				const character = pending[index];
				if (character !== "\n" && character !== "\r") continue;
				if (character === "\r" && index === pending.length - 1 && !done) break;
				consumeLine(pending.slice(lineStart, index), state, onEvent);
				if (character === "\r" && pending[index + 1] === "\n") index += 1;
				lineStart = index + 1;
			}
			pending = pending.slice(lineStart);
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}
