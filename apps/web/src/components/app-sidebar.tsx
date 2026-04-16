"use client";

import {
  BarChart3,
  Check,
  ChevronUp,
  Clock,
  Key,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Plug,
  Settings,
  Sparkles,
  Sun,
  User,
} from "lucide-react";
import { useClerk, useUser } from "@clerk/nextjs";
import { useTheme } from "next-themes";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpen]);

  return (
    <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-5">
        <Image src="/clawdi.svg" alt="Clawdi" width={24} height={24} />
        <span className="font-semibold text-base">Clawdi Cloud</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-1 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
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

      {/* User footer with popup menu */}
      <div className="relative border-t border-sidebar-border" ref={menuRef}>
        {/* Popup menu */}
        {menuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-popover border border-border rounded-lg shadow-lg py-1 z-50">
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              <Settings className="size-4" />
              Settings
            </Link>
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              <User className="size-4" />
              Profile
            </Link>

            <div className="h-px bg-border my-1" />

            {/* Theme switcher */}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-xs text-muted-foreground">Theme</span>
              <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
                {(
                  [
                    { value: "light", icon: Sun, label: "Light" },
                    { value: "dark", icon: Moon, label: "Dark" },
                    { value: "system", icon: Monitor, label: "System" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    title={opt.label}
                    onClick={() => setTheme(opt.value)}
                    className={cn(
                      "rounded-md p-1.5 transition-colors",
                      theme === opt.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <opt.icon className="size-3.5" />
                  </button>
                ))}
              </div>
            </div>

            <div className="h-px bg-border my-1" />

            <button
              type="button"
              onClick={() => signOut({ redirectUrl: "/sign-in" })}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
            >
              <LogOut className="size-4" />
              Sign out
            </button>
          </div>
        )}

        {/* User button */}
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-sidebar-accent transition-colors"
        >
          {user?.imageUrl ? (
            <Image
              src={user.imageUrl}
              alt=""
              width={28}
              height={28}
              className="rounded-full shrink-0"
            />
          ) : (
            <div className="size-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium shrink-0">
              {user?.fullName?.[0] ?? "U"}
            </div>
          )}
          <div className="min-w-0 flex-1 text-left">
            <div className="text-sm font-medium truncate">
              {user?.fullName}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {user?.primaryEmailAddress?.emailAddress}
            </div>
          </div>
          <ChevronUp
            className={cn(
              "size-4 text-muted-foreground shrink-0 transition-transform",
              menuOpen && "rotate-180",
            )}
          />
        </button>
      </div>
    </aside>
  );
}
