import { useLocalSearchParams } from "expo-router";
import { AgentPluginsScreen } from "@/hosted/v2/agent-plugins/agent-plugins-surface";
import { routeParam } from "@/lib/route-params";
export default function AgentPluginDetail() {
	const { pluginName } = useLocalSearchParams<{ pluginName?: string | string[] }>();
	return <AgentPluginsScreen pluginName={routeParam(pluginName)} />;
}
