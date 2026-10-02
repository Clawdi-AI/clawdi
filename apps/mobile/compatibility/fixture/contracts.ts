import { ClerkProvider, type useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { QueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";

export const clerkTokenCache = tokenCache satisfies ComponentProps<
	typeof ClerkProvider
>["tokenCache"];
export type ClerkGetToken = ReturnType<typeof useAuth>["getToken"];
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
export const sdkBundleProbe = { ClerkProvider, tokenCache, queryClient };
