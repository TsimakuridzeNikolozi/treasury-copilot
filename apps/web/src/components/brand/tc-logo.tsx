import { cn } from '@/lib/utils';

// Monogram + wordmark. The mark is a stacked bracket-and-bar that reads as
// "copilot + ledger" — kept strictly monochrome so the cyan accent stays
// reserved for status / focus / primary actions. `showWord` toggles to
// monogram-only for tight surfaces (chat sidebar header).
export function TCMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8 9.5h8M8 14.5h5" />
    </svg>
  );
}

export function TCLogo({
  size = 18,
  showWord = true,
  className,
}: {
  size?: number;
  showWord?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <TCMark size={size} />
      {showWord ? (
        <span
          className="font-semibold tracking-tight"
          // Inline font-size so the wordmark scales with the mark.
          style={{ fontSize: size * 0.85 }}
        >
          Treasury Copilot
        </span>
      ) : null}
    </span>
  );
}
