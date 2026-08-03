import { Badge } from "@/components/ui/badge";
import { ALL_AGENTS_ACCESS_LABEL } from "@/lib/agent-resource-access";

export function AllAgentsAccessBadge() {
	return (
		<Badge variant="outline" className="font-normal text-muted-foreground">
			{ALL_AGENTS_ACCESS_LABEL}
		</Badge>
	);
}
