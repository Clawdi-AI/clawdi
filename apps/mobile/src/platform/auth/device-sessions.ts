import type { SessionResource, UserResource } from "@clerk/expo/types";

type SessionOwner = Pick<SessionResource, "id" | "status"> & {
	user: Pick<UserResource, "id" | "getSessions"> | null;
};
type ClientView = { sessions: readonly SessionOwner[] };

/** Public Clerk reload reconstructs users; reject cached or swallowed-error inventories. */
export async function readDeviceSessions(
	client: ClientView & { reload(): Promise<ClientView> },
	userId: string,
	sessionId: string,
	isCurrent: () => boolean,
) {
	const check = () => {
		if (!isCurrent()) throw new Error("Account read retired");
	};
	check();
	const previous = client.sessions.find((session) => session.id === sessionId)?.user;
	const refreshed = await client.reload();
	check();
	const current = refreshed.sessions.find((session) => session.id === sessionId);
	if (current?.status !== "active" || current.user?.id !== userId || current.user === previous)
		throw new Error("Fresh account session unavailable");
	const sessions = await current.user.getSessions();
	check();
	if (
		!sessions.some((session) => session.id === sessionId && session.status === "active") ||
		sessions.some((session) => !session.id) ||
		new Set(sessions.map((session) => session.id)).size !== sessions.length
	)
		throw new Error("Incomplete session inventory");
	return sessions.filter((session) => session.status === "active");
}
