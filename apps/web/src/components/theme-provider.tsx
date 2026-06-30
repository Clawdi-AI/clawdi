"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

type Theme = "light" | "dark" | "system";

type ThemeProviderProps = {
	children: ReactNode;
	attribute?: "class";
	defaultTheme?: Theme;
	enableSystem?: boolean;
	disableTransitionOnChange?: boolean;
};

type ThemeContextValue = {
	theme: Theme;
	resolvedTheme: "light" | "dark";
	setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "clawdi-theme";

function systemTheme(): "light" | "dark" {
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme, enableSystem: boolean) {
	if (typeof document === "undefined") return "light";
	const resolved =
		theme === "system" && enableSystem ? systemTheme() : theme === "dark" ? "dark" : "light";
	document.documentElement.classList.toggle("dark", resolved === "dark");
	return resolved;
}

export function ThemeProvider({
	children,
	defaultTheme = "system",
	enableSystem = true,
}: ThemeProviderProps) {
	const [theme, setThemeState] = useState<Theme>(() => {
		if (typeof window === "undefined") return defaultTheme;
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return stored === "light" || stored === "dark" || stored === "system" ? stored : defaultTheme;
	});
	const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
		theme === "system" && enableSystem ? systemTheme() : theme === "dark" ? "dark" : "light",
	);

	useEffect(() => {
		setResolvedTheme(applyTheme(theme, enableSystem));
		if (typeof window === "undefined") return;
		window.localStorage.setItem(STORAGE_KEY, theme);
	}, [enableSystem, theme]);

	useEffect(() => {
		if (!enableSystem || typeof window === "undefined") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			if (theme === "system") setResolvedTheme(applyTheme(theme, enableSystem));
		};
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [enableSystem, theme]);

	const setTheme = useCallback((nextTheme: Theme) => {
		setThemeState(nextTheme);
	}, []);

	const value = useMemo(
		() => ({ theme, resolvedTheme, setTheme }),
		[resolvedTheme, setTheme, theme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		return {
			theme: "system" as Theme,
			resolvedTheme: "light" as const,
			setTheme: (_theme: Theme) => {},
		};
	}
	return context;
}
