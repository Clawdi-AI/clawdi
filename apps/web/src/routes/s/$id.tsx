import { createFileRoute, notFound } from "@tanstack/react-router";
import { routeHeadTitle } from "@/lib/document-title";
import PublicSharePage from "@/pages/public-share/session-page";
import { getPublicShareData } from "@/pages/public-share/session-page.functions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/s/$id")({
	head: () => routeHeadTitle("Shared Session"),
	loader: async ({ abortController, params }) => {
		if (!UUID_RE.test(params.id)) throw notFound();
		const result = await getPublicShareData({
			data: { sessionId: params.id },
			signal: abortController.signal,
		});
		if (result.kind === "not-found") throw notFound();
		return result;
	},
	component: PublicShareRoute,
});

function PublicShareRoute() {
	const { id } = Route.useParams();
	const result = Route.useLoaderData();
	return <PublicSharePage id={id} result={result} />;
}
