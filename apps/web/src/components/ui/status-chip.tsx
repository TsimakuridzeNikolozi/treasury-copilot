import { Chip } from '@/components/ui/chip';
import { Spinner } from '@/components/ui/spinner';

// Action lifecycle → chip mapping. Kept as a const at module scope so React
// doesn't re-create the object literal on every render. Add new statuses
// here so every surface picks up the same tone automatically.
export type ActionStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'failed' | 'denied';

const STATUS_DEFS: Record<
  ActionStatus,
  { tone: 'neutral' | 'primary' | 'primarySolid' | 'destructive'; label: string }
> = {
  pending: { tone: 'neutral', label: 'Pending' },
  approved: { tone: 'primary', label: 'Approved' },
  executing: { tone: 'primary', label: 'Executing' },
  executed: { tone: 'primarySolid', label: 'Executed' },
  failed: { tone: 'destructive', label: 'Failed' },
  denied: { tone: 'destructive', label: 'Denied' },
};

export function StatusChip({ status }: { status: ActionStatus }) {
  const def = STATUS_DEFS[status] ?? STATUS_DEFS.pending;
  return (
    <Chip
      tone={def.tone}
      // Executing replaces the leading dot with a spinner; every other
      // status uses the dot so the chip reads as a status indicator.
      dot={status !== 'executing'}
      aria-label={`Status: ${def.label.toLowerCase()}`}
    >
      {status === 'executing' ? <Spinner className="size-2.5" /> : null}
      {def.label}
    </Chip>
  );
}
