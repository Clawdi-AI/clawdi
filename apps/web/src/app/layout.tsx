import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import "./globals.css";

const fontSans = Geist({
	variable: "--font-sans",
	subsets: ["latin"],
});

const fontMono = Geist_Mono({
	variable: "--font-mono",
	subsets: ["latin"],
});

// Resolve the canonical site URL per deployment env so OG/canonical tags
// point at the actual host serving the page:
//   - production on Vercel with a custom domain set → cloud.clawdi.ai
//   - preview on Vercel                             → <branch>.vercel.app
//   - anywhere else (local dev, CI)                 → localhost:3000
// The `cloud.clawdi.ai` literal stays only as a hard fallback for
// non-Vercel builds that still want reasonable absolute URLs.
function resolveSiteUrl(): string {
	if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) {
		return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
	}
	if (env.VERCEL_URL) {
		return `https://${env.VERCEL_URL}`;
	}
	return "https://cloud.clawdi.ai";
}

const SITE_URL = resolveSiteUrl();
const DESCRIPTION =
	"Cloud control plane for AI agents — manage sessions, skills, memories, and secrets across the machines you connect.";

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	// Per-page layouts/pages can override `title` with a plain string and
	// this template will suffix " · Clawdi Cloud" automatically.
	title: {
		default: "Clawdi Cloud",
		template: "%s · Clawdi Cloud",
	},
	description: DESCRIPTION,
	applicationName: "Clawdi Cloud",
	manifest: "/site.webmanifest",
	icons: {
		icon: [
			{ url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
			{ url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
		],
		shortcut: "/favicon.ico",
		apple: "/apple-touch-icon.png",
	},
	openGraph: {
		type: "website",
		siteName: "Clawdi Cloud",
		title: "Clawdi Cloud",
		description: DESCRIPTION,
		url: SITE_URL,
	},
	twitter: {
		card: "summary",
		title: "Clawdi Cloud",
		description: DESCRIPTION,
	},
	// Private beta: keep the dashboard out of search indexes until launch.
	// Remove this block (or flip values) when going public.
	robots: {
		index: false,
		follow: false,
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<ClerkProvider appearance={{ baseTheme: shadcn }}>
			<html lang="en" className="h-full" suppressHydrationWarning>
				<body
					className={cn(
						fontSans.variable,
						fontMono.variable,
						"flex min-h-full flex-col antialiased",
					)}
				>
					<Providers>{children}</Providers>
				</body>
			</html>
		</ClerkProvider>
	);
}
