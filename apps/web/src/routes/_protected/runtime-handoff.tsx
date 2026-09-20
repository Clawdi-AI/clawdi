import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

function validateRuntimeHandoffSearch(search: Record<string, unknown>) {
	const deploymentId = search.deployment_id;
	if (typeof deploymentId !== "string" || !/^hdep_[A-Za-z0-9]{8,}$/.test(deploymentId)) {
		throw new Error("Invalid runtime handoff.");
	}
	return { deployment_id: deploymentId };
}

export const Route = createFileRoute("/_protected/runtime-handoff")({
	validateSearch: validateRuntimeHandoffSearch,
	head: () => ({ meta: [{ title: "Opening Hermes · Clawdi" }] }),
	component: lazyRouteComponent(
		() => import("@/hosted/agents/runtime-handoff"),
		"RuntimeHandoffPage",
	),
});
