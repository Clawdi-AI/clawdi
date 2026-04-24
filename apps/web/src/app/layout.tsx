import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
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

export const metadata: Metadata = {
	title: "Clawdi Cloud",
	description: "iCloud for AI Agents",
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
