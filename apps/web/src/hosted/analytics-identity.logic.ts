export type HostedAuthIdentityAction =
	| { type: "identify"; userId: string }
	| { type: "reset" }
	| { type: "none" };

export function resolveHostedAuthIdentityAction({
	isSignedIn,
	userId,
	lastIdentifiedUserId,
}: {
	isSignedIn: boolean;
	userId: string | null | undefined;
	lastIdentifiedUserId: string | null;
}): {
	action: HostedAuthIdentityAction;
	nextIdentifiedUserId: string | null;
} {
	if (isSignedIn && userId) {
		if (lastIdentifiedUserId === userId) {
			return {
				action: { type: "none" },
				nextIdentifiedUserId: lastIdentifiedUserId,
			};
		}
		return {
			action: { type: "identify", userId },
			nextIdentifiedUserId: userId,
		};
	}

	if (lastIdentifiedUserId !== null) {
		return {
			action: { type: "reset" },
			nextIdentifiedUserId: null,
		};
	}

	return {
		action: { type: "none" },
		nextIdentifiedUserId: null,
	};
}
