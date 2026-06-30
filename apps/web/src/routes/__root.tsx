/// <reference types="vite/client" />

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import "../../instrumentation-client";
import { AuthProvider } from "@/components/auth-provider";
import { Providers } from "@/components/providers";
import RootError from "@/components/root-error";
import "@/styles/globals.css";

const DESCRIPTION =
	"Cloud control plane for AI agents - manage sessions, skills, memories, and secrets across the machines you connect.";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Clawdi" },
			{ name: "description", content: DESCRIPTION },
			{ name: "robots", content: "noindex,nofollow" },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: "Clawdi" },
			{ property: "og:title", content: "Clawdi" },
			{ property: "og:description", content: DESCRIPTION },
			{ name: "twitter:card", content: "summary" },
			{ name: "twitter:title", content: "Clawdi" },
			{ name: "twitter:description", content: DESCRIPTION },
		],
		links: [
			{ rel: "manifest", href: "/site.webmanifest" },
			{ rel: "icon", href: "/favicon.ico" },
			{ rel: "icon", href: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
			{ rel: "icon", href: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
		],
	}),
	errorComponent: ({ error, reset }) => <RootError error={error} reset={reset} />,
	notFoundComponent: () => (
		<div className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="space-y-2 text-center">
				<h1 className="font-semibold text-lg">Page not found</h1>
				<p className="text-muted-foreground text-sm">This Clawdi page does not exist.</p>
			</div>
		</div>
	),
	component: RootComponent,
});

function RootComponent() {
	return (
		<RootDocument>
			<AuthProvider>
				<Providers>
					<Outlet />
				</Providers>
			</AuthProvider>
		</RootDocument>
	);
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang="en" className="h-full" suppressHydrationWarning>
			<head>
				<script
					dangerouslySetInnerHTML={{
						__html:
							'try{var t=localStorage.getItem("clawdi-theme")||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}',
					}}
				/>
				<HeadContent />
			</head>
			<body className="flex min-h-full flex-col antialiased">
				{children}
				<Scripts />
			</body>
		</html>
	);
}
