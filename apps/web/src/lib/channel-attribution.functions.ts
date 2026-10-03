import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, setResponseHeader } from "@tanstack/react-start/server";
import {
	CHANNEL_ATTRIBUTION_COOKIE,
	verifyChannelAttribution,
} from "@/lib/channel-attribution.server";

/** Only the authenticated deploy page can read the verified campaign credential. */
export const getChannelAttribution = createServerFn({ method: "GET" }).handler(async () => {
	setResponseHeader("cache-control", "private, no-store");
	const { userId } = await auth();
	if (!userId) return null;
	return verifyChannelAttribution(
		getCookie(CHANNEL_ATTRIBUTION_COOKIE),
		process.env.CHANNEL_ATTRIBUTION_SECRET,
	);
});
