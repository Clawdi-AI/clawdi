"use client";

import { createContext, createElement, type ReactNode, useContext } from "react";

export type LegacyProductAccessStatus = "unresolved" | "enabled" | "disabled";
export type ProductAccessStatus = "unavailable" | "loading" | "error" | "allowed" | "denied";

export type ProductAccess = {
	canUseLegacyHostedDashboard: boolean;
	legacyHostedAccessStatus: LegacyProductAccessStatus;
	legacyDashboardUrl: string | null;
	canCreateCloudAgents: boolean;
	canUseCloudAgents: boolean;
	status: ProductAccessStatus;
	isLoading: boolean;
	isError: boolean;
	isAllowed: boolean;
	isDenied: boolean;
	isFetching: boolean;
	error: unknown;
	refetch: () => Promise<void>;
	recheckCanCreateCloudAgents: () => Promise<boolean>;
};

const noopRefetch = async () => {};
const denyCloudAgentCreation = async () => false;

export const UNAVAILABLE_PRODUCT_ACCESS: ProductAccess = {
	canUseLegacyHostedDashboard: false,
	legacyHostedAccessStatus: "unresolved",
	legacyDashboardUrl: null,
	canCreateCloudAgents: false,
	canUseCloudAgents: false,
	status: "unavailable",
	isLoading: false,
	isError: false,
	isAllowed: false,
	isDenied: false,
	isFetching: false,
	error: null,
	refetch: noopRefetch,
	recheckCanCreateCloudAgents: denyCloudAgentCreation,
};

export const LOADING_PRODUCT_ACCESS: ProductAccess = {
	...UNAVAILABLE_PRODUCT_ACCESS,
	status: "loading",
	isLoading: true,
	isFetching: true,
};

const ProductAccessContext = createContext<ProductAccess>(UNAVAILABLE_PRODUCT_ACCESS);

export function ProductAccessProvider({
	value,
	children,
}: {
	value: ProductAccess;
	children: ReactNode;
}) {
	return createElement(ProductAccessContext.Provider, { value }, children);
}

export function useProductAccess(): ProductAccess {
	return useContext(ProductAccessContext);
}
