'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

// Settings-page header element. Owners need to copy this address to fund
// the wallet (USDC + a little SOL); the small "Copied" pulse mirrors the
// PolicyForm "Saved" pulse so the success affordance is consistent.
//
// Client component because navigator.clipboard + state need to live in the
// browser. The address itself comes from the server page via prop.
export function WalletAddressBlock({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard can fail (insecure context, permissions) — no recovery
      // path makes sense here; the user can select + Ctrl-C the <code>.
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-4">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">Treasury wallet</span>
      <div className="flex items-center gap-2">
        <code className="break-all font-mono text-sm">{address}</code>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy wallet address"
          className="-m-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {copied ? (
            <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <CopyIcon className="size-4" aria-hidden />
          )}
        </button>
        {copied && (
          <span aria-live="polite" className="text-emerald-600 text-xs dark:text-emerald-400">
            Copied
          </span>
        )}
      </div>
      <p className="mt-1 text-muted-foreground text-xs">
        Fund this wallet by sending USDC on Solana to the address above. A small SOL balance (~0.05
        SOL) is also needed to cover transaction fees.
      </p>
    </div>
  );
}
