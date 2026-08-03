import { Badge } from "@/components/ui/badge";
import { ACCOUNT_WIDE_SCOPE_LABEL } from "@/lib/account-wide-resources";

export function AccountWideScopeBadge() {
	return (
		<Badge variant="outline" className="font-normal text-muted-foreground">
			{ACCOUNT_WIDE_SCOPE_LABEL}
		</Badge>
	);
}
