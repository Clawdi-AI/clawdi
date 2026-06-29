import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "@/lib/env";

const getAuthState = createServerFn({ method: "GET" }).handler(async () => {
	if (env.NEXT_PUBLIC_DEV_AUTH_BYPASS) return { userId: "dev_browser" };
	const { userId } = await auth();
	return { userId };
});

export const Route = createFileRoute("/_protected")({
	beforeLoad: async ({ location }) => {
		const { userId } = await getAuthState();
		if (!userId) {
			throw redirect({
				to: "/sign-in",
				search: { redirect_url: location.href },
			});
		}
	},
	component: Outlet,
});
