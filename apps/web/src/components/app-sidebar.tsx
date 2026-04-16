"use client";

import {
  BarChart3,
  Clock,
  Key,
  LayoutDashboard,
  LogOut,
  Moon,
  Plug,
  Settings,
  Sparkles,
  Sun,
  Zap,
} from "lucide-react";
import { useClerk, useUser } from "@clerk/nextjs";
import { useTheme } from "next-themes";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/sessions", label: "Sessions", icon: BarChart3 },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/vault", label: "Vault", icon: Key },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/cron", label: "Cron Jobs", icon: Clock },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { theme, setTheme } = useTheme();

  return (
    <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <Image src="/clawdi.svg" alt="Clawdi" width={24} height={24} />
        <span className="font-semibold text-base">Clawdi Cloud</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border px-3 py-3 space-y-0.5">
        <Link
          href="/settings"
          className={cn(
            "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
            pathname === "/settings"
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <Settings className="size-4" />
          Settings
        </Link>

        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
        >
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
          <span className="dark:hidden">Dark mode</span>
          <span className="hidden dark:inline">Light mode</span>
        </button>

        <button
          type="button"
          onClick={() => signOut({ redirectUrl: "/sign-in" })}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
        >
          <LogOut className="size-4" />
          Sign out
        </button>

        {/* User info */}
        {user && (
          <div className="flex items-center gap-2.5 px-3 py-2 mt-1">
            {user.imageUrl && (
              <Image
                src={user.imageUrl}
                alt=""
                width={28}
                height={28}
                className="rounded-full"
              />
            )}
            <div className="min-w-0">
              <div className="text-xs font-medium truncate">
                {user.fullName}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {user.primaryEmailAddress?.emailAddress}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
