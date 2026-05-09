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
import { CheckIcon, ChevronDownIcon, WalletIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface TreasuryListEntry {
  id: string;
  name: string;
  walletAddress: string;
  role: string;
  joinedAt: string;
}

// Renders the active treasury + chevron in the trigger; opens to a list
// of memberships fetched from `GET /api/treasury`. Selecting a row POSTs
// `/api/treasury/active` and forces a full page reload — clears in-memory
// chat state and avoids stale-policy footguns where the form on screen
// reflects a different treasury than the one the cookie now points at.
export function TreasurySwitcher({ activeTreasuryId }: { activeTreasuryId?: string }) {
  const { getAccessToken, ready } = usePrivy();
  const [treasuries, setTreasuries] = useState<TreasuryListEntry[] | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `getAccessToken` from usePrivy() is recreated on every parent
  // render, so listing it as an effect dep would re-fetch /api/treasury
  // each time. Mirror the chat client's ref pattern: read latest via
  // ref, depend only on `ready`.
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessTokenRef.current();
        const res = await fetch('/api/treasury', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`/api/treasury → ${res.status}`);
        const list = (await res.json()) as TreasuryListEntry[];
        if (!cancelled) setTreasuries(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  // Resolve the visible "current" name: prefer the entry matching
  // activeTreasuryId; fall back to the first row; fall back to a
  // placeholder while loading.
  const current = treasuries?.find((t) => t.id === activeTreasuryId) ?? treasuries?.[0] ?? null;

  const onSelect = async (treasuryId: string) => {
    if (treasuryId === activeTreasuryId) return;
    setSwitching(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/treasury/active', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ treasuryId }),
      });
      if (!res.ok) throw new Error(`switch failed: ${res.status}`);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={!ready || switching || !treasuries}
          aria-label="Switch treasury"
        >
          <WalletIcon className="size-3.5" aria-hidden />
          <span className="max-w-[140px] truncate text-xs">
            {current?.name ?? (treasuries ? '—' : 'Loading…')}
          </span>
          <ChevronDownIcon className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs">Treasuries</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error ? (
          <div className="px-2 py-1.5 text-destructive text-xs">{error}</div>
        ) : !treasuries ? (
          <div className="px-2 py-1.5 text-muted-foreground text-xs">Loading…</div>
        ) : treasuries.length === 0 ? (
          <div className="px-2 py-1.5 text-muted-foreground text-xs">No treasuries</div>
        ) : (
          treasuries.map((t) => {
            const active = t.id === activeTreasuryId;
            return (
              <DropdownMenuItem
                key={t.id}
                onSelect={() => onSelect(t.id)}
                className="cursor-pointer"
              >
                <div className="flex w-full items-center gap-2">
                  <span className="flex-1 truncate">{t.name}</span>
                  {active && <CheckIcon className="size-4" aria-hidden />}
                </div>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
