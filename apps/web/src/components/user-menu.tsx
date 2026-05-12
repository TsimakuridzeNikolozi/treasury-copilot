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
import { usePrivy } from '@privy-io/react-auth';
import { LogOutIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const LOGOUT_TIMEOUT_MS = 4000;

// Avatar circle + truncated email + logout. Extracted from the old
// AppNav so the AppShell header can compose it alongside other tools
// without dragging in nav-link logic that's no longer global.
export function UserMenu() {
  const router = useRouter();
  const { user, logout, ready } = usePrivy();

  const identity = user?.email?.address ?? user?.id ?? '';
  const initial = identity.charAt(0).toUpperCase() || '?';
  const shortId = user?.id ? `…${user.id.slice(-6)}` : null;

  const onSignOut = async () => {
    // Clear our active-treasury cookie in parallel with Privy's session
    // teardown so user A's selection doesn't leak to user B on the same
    // browser. /api/auth/logout is bounded by a short timeout so routing
    // still proceeds if the network hangs.
    try {
      await Promise.allSettled([logout(), clearActiveTreasuryCookie()]);
    } finally {
      router.replace('/');
    }
  };

  return (
    <DropdownMenu modal={false}>
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
          <span className="hidden max-w-[140px] truncate font-mono text-xs sm:inline">
            {user?.email?.address ?? shortId ?? 'guest'}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Signed in as</span>
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
  );
}

async function clearActiveTreasuryCookie() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);

  try {
    await fetch('/api/auth/logout', { method: 'POST', signal: controller.signal });
  } catch {
    // Navigation still happens in the sign-out handler's finally block.
  } finally {
    window.clearTimeout(timeoutId);
  }
}
