"use client";

import { Link, useLocation } from "@tanstack/react-router";
import { Fragment } from "react";
import { buildAppBreadcrumbTrail } from "@/components/app-breadcrumb-model";
import { useBreadcrumbSegmentTitles, useBreadcrumbTitle } from "@/components/breadcrumb-title";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
export function AppBreadcrumb() {
	const pathname = useLocation({ select: (location) => location.pathname });
	const routeSearch = useLocation({ select: (location) => location.search });
	const overrideTitle = useBreadcrumbTitle();
	const segmentTitles = useBreadcrumbSegmentTitles();
	const trail = buildAppBreadcrumbTrail({
		pathname,
		search: routeSearch,
		overrideTitle,
		segmentTitles,
	});

	return (
		<Breadcrumb>
			<BreadcrumbList>
				{trail.map((item, i) => {
					const isLast = i === trail.length - 1;
					const label = item.label ?? <BreadcrumbNamePlaceholder />;
					return (
						<Fragment key={item.key}>
							<BreadcrumbItem className={isLast ? undefined : "hidden sm:inline-flex"}>
								{isLast ? (
									<BreadcrumbPage className="max-w-[calc(100vw-6rem)] truncate sm:max-w-[420px]">
										{label}
									</BreadcrumbPage>
								) : item.href && item.label ? (
									<BreadcrumbLink
										className="inline-block max-w-40 truncate align-bottom lg:max-w-56"
										render={<Link to={item.href} />}
									>
										{label}
									</BreadcrumbLink>
								) : (
									<BreadcrumbPage>{label}</BreadcrumbPage>
								)}
							</BreadcrumbItem>
							{!isLast ? <BreadcrumbSeparator className="hidden sm:block" /> : null}
						</Fragment>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}

function BreadcrumbNamePlaceholder() {
	return (
		<span className="inline-flex items-center">
			<span className="sr-only">Loading name</span>
			<span aria-hidden className="h-4 w-20 rounded bg-muted" />
		</span>
	);
}
