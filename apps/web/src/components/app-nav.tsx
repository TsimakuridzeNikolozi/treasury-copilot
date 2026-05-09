'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { CoinsIcon, LogOutIcon, MessageSquareIcon, SettingsIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_LINKS = [
  { href: '/chat', label: 'Chat', icon: MessageSquareIcon },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, ready } = usePrivy();

  const identity = user?.email?.address ?? user?.id ?? '';
  const initial = identity.charAt(0).toUpperCase() || '?';
  const shortId = user?.id ? `…${user.id.slice(-6)}` : null;

  const onSignOut = async () => {
    await logout();
    router.replace('/');
  };

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-md bg-foreground text-background"
          >
            <CoinsIcon className="size-4" />
          </span>
          <span className="font-semibold text-sm tracking-tight">Treasury Copilot</span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="Main">
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  active
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              aria-label="Account menu"
              disabled={!ready}
            >
              <span
                aria-hidden
                className="flex size-5 items-center justify-center rounded-full bg-foreground font-medium text-[10px] text-background"
              >
                {initial}
              </span>
              <span className="max-w-[140px] truncate font-mono text-xs">
                {user?.email?.address ?? shortId ?? 'guest'}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Signed in as</span>
                <span className="truncate font-mono text-xs" title={identity}>
                  {identity || 'unknown'}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings" className="cursor-pointer">
                <UserIcon className="mr-2 size-4" aria-hidden />
                Account &amp; policy
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onSignOut}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOutIcon className="mr-2 size-4" aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
