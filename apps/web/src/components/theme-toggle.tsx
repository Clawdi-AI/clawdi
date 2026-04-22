"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Three-way theme cycle: system → light → dark → system.
 * Icon reflects current resolved preference; a11y label describes next action.
 */
export function ThemeToggle({ className }: { className?: string }) {
	const [mounted, setMounted] = useState(false);
	const { theme, setTheme, resolvedTheme } = useTheme();

	useEffect(() => setMounted(true), []);

	if (!mounted) {
		return (
			<div
				className={cn("size-8 rounded-md border border-input bg-background", className)}
				aria-hidden
			/>
		);
	}

	const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";

	return (
		<button
			type="button"
			onClick={() => setTheme(next)}
			className={cn(
				"inline-flex size-8 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring",
				className,
			)}
			aria-label={`Switch to ${next} theme`}
			title={`Theme: ${theme ?? "system"} → click for ${next}`}
		>
			{theme === "system" ? (
				<Monitor className="size-4" />
			) : resolvedTheme === "dark" ? (
				<Moon className="size-4" />
			) : (
				<Sun className="size-4" />
			)}
		</button>
	);
}
