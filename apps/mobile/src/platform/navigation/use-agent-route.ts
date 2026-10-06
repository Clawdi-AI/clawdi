import { useLocalSearchParams, useSegments } from "expo-router";
import { routeParam } from "@/lib/route-params";

/** Pathless tab groups do not change the Agent URL context. */
export function useAgentRouteId() {
	const segments = useSegments();
	const { id } = useLocalSearchParams<{ id?: string | string[] }>();
	return segments.some((segment) => segment === "agents") ? routeParam(id) : undefined;
}
