'use client';

import { TreasurySwitcher } from '@/components/treasury-switcher';
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

interface AppNavProps {
  // Forwarded to TreasurySwitcher so the dropdown can highlight the
  // current row. Optional: when undefined the switcher fetches the list
  // and uses [0] as a fallback. Server pages know it; the resulting
  // prop chain keeps the switcher read consistent.
  activeTreasuryId?: string;
}

export function AppNav({ activeTreasuryId }: AppNavProps = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, ready } = usePrivy();

  const identity = user?.email?.address ?? user?.id ?? '';
  const initial = identity.charAt(0).toUpperCase() || '?';
  const shortId = user?.id ? `…${user.id.slice(-6)}` : null;

  const onSignOut = async () => {
    // Clear our active-treasury cookie in parallel with Privy's session
    // teardown so user A's selection doesn't leak to user B on the same
    // browser. The /api/auth/logout call is fire-and-forget — the cookie
    // clear is idempotent and a network blip can't make it harmful.
    await Promise.allSettled([logout(), fetch('/api/auth/logout', { method: 'POST' })]);
    router.replace('/');
  };

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
            >
              <CoinsIcon className="size-4" />
            </span>
            <span className="font-semibold text-sm tracking-tight">Treasury Copilot</span>
          </Link>
          <TreasurySwitcher activeTreasuryId={activeTreasuryId} />
        </div>

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
                className="flex size-5 items-center justify-center rounded-full bg-primary font-medium text-[10px] text-primary-foreground"
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
