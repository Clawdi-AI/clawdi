"use client";

import { useEffect, useMemo, useRef } from "react";
import { legacyHostedDashboardUrl } from "@/hosted/access/legacy-dashboard-url";
import { useHostedProductAccessQuery } from "@/hosted/access/product-access";
import { publishProductAccessProjection } from "@/hosted/access/product-access-projection";
import type { ProductAccess } from "@/lib/product-access";

export function HostedProductAccessSensor({
	onChange,
}: {
	onChange: (access: ProductAccess) => void;
}) {
	const access = useHostedProductAccessQuery();
	const projection = useMemo<ProductAccess>(
		() => ({ ...access, legacyDashboardUrl: legacyHostedDashboardUrl() }),
		[access],
	);
	const lastPublished = useRef<ProductAccess | null>(null);

	useEffect(
		() => publishProductAccessProjection(lastPublished, projection, onChange),
		[onChange, projection],
	);

	return null;
}
