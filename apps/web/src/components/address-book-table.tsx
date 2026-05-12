'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import {
  CheckCircle2Icon,
  CheckIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

// Wire shape imported from the shared DTO module — single source of truth
// across the route handlers, the settings page, and this client component.
// The DTO file is server-safe (doesn't pull @tc/db into the client bundle).
export type { AddressBookEntryDto } from '@/lib/dto/address-book';
import type { AddressBookEntryDto } from '@/lib/dto/address-book';

// Mirrors the server route's regex. Live validation in the form so the
// user sees a red border before the round-trip; the server still
// authoritatively rejects junk.
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LABEL_MAX = 64;
const NOTES_MAX = 500;

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

export function AddressBookTable({
  initial,
  treasuryId,
}: {
  initial: AddressBookEntryDto[];
  treasuryId: string;
}) {
  const { getAccessToken } = usePrivy();

  const [entries, setEntries] = useState<AddressBookEntryDto[]>(initial);
  const [addOpen, setAddOpen] = useState(false);
  // Locally-mutated success pulse. Per-id so it can sit next to the
  // edited row without competing with the "added" pulse on a fresh row.
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  // Top-level error from add/delete; per-row edit errors stay scoped
  // to the row.
  const [topError, setTopError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: treasuryId / initial identity must reset.
  useEffect(() => {
    setEntries(initial);
    setAddOpen(false);
    setSavedFlash(null);
    setTopError(null);
  }, [treasuryId, initial]);

  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => setSavedFlash(null), 4000);
    return () => clearTimeout(t);
  }, [savedFlash]);

  // 409 handling shared across create/update/delete. Mirrors policy /
  // telegram-config forms: a moved treasury reloads the page;
  // no_active_treasury sends the user to onboarding.
  //
  // Takes a pre-parsed body so callers can read other error codes first
  // (e.g. duplicate_label) without exhausting the Response stream. A
  // prior version of this code re-called res.json() inside the helper,
  // which silently fell through to reload() on no_active_treasury when
  // the caller had already consumed the body.
  const handle409 = (body: { error?: string }): true => {
    if (body.error === 'no_active_treasury') {
      window.location.replace('/');
      return true;
    }
    window.location.reload();
    return true;
  };

  const onCreate = async (input: {
    label: string;
    recipientAddress: string;
    notes: string | null;
    preApproved: boolean;
  }): Promise<string | null> => {
    setTopError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/treasury/address-book', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ treasuryId, ...input }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          field?: string;
        };
        if (body.error === 'duplicate_label') return 'A recipient with that label already exists.';
        if (body.error === 'duplicate_address')
          return 'This address is already in your address book.';
        if (body.error === 'no_active_treasury') {
          window.location.replace('/');
          return null;
        }
        window.location.reload();
        return null;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      const created = (await res.json()) as AddressBookEntryDto;
      // Server orders list by created_at desc; prepend so the UI matches
      // the server view without a refetch.
      setEntries((cur) => [created, ...cur]);
      setSavedFlash(created.id);
      setAddOpen(false);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTopError(msg);
      return msg;
    }
  };

  const onUpdate = async (
    id: string,
    input: { label: string; notes: string | null; preApproved: boolean },
  ): Promise<string | null> => {
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/treasury/address-book/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ treasuryId, ...input }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'duplicate_label') return 'A recipient with that label already exists.';
        handle409(body);
        return null;
      }
      if (res.status === 404) return 'Recipient was removed.';
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      const updated = (await res.json()) as AddressBookEntryDto;
      setEntries((cur) => cur.map((e) => (e.id === id ? updated : e)));
      setSavedFlash(updated.id);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const onDelete = async (id: string): Promise<string | null> => {
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/treasury/address-book/${id}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        handle409(body);
        return null;
      }
      if (res.status === 404) {
        // Already gone — drop locally so the UI matches the server.
        setEntries((cur) => cur.filter((e) => e.id !== id));
        return null;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      setEntries((cur) => cur.filter((e) => e.id !== id));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {addOpen ? (
        <AddEntryForm onSubmit={onCreate} onCancel={() => setAddOpen(false)} />
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {entries.length === 0
              ? 'No recipients yet. Add a recipient to use labels in chat and pre-approve trusted payees.'
              : `${entries.length} recipient${entries.length === 1 ? '' : 's'}`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setTopError(null);
              setAddOpen(true);
            }}
            className="gap-1.5"
          >
            <PlusIcon className="size-3.5" aria-hidden />
            Add recipient
          </Button>
        </div>
      )}

      {topError && (
        <p className="text-destructive text-xs" role="alert">
          {topError}
        </p>
      )}

      {entries.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border bg-card">
          {entries.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              onUpdate={(input) => onUpdate(e.id, input)}
              onDelete={() => onDelete(e.id)}
              flash={savedFlash === e.id}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddEntryForm({
  onSubmit,
  onCancel,
}: {
  // Returns an error message string if the submit failed (e.g. dup label,
  // network), or null on success. The form stays open on error so the
  // user can fix and retry without re-entering the address.
  onSubmit: (input: {
    label: string;
    recipientAddress: string;
    notes: string | null;
    preApproved: boolean;
  }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [preApproved, setPreApproved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labelError = useMemo(() => {
    const trimmed = label.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > LABEL_MAX) return `Label is at most ${LABEL_MAX} chars.`;
    return undefined;
  }, [label]);
  const addressError = useMemo(() => {
    const trimmed = address.trim();
    if (trimmed.length === 0) return undefined;
    return SOLANA_ADDRESS_REGEX.test(trimmed) ? undefined : 'Not a base58 Solana address.';
  }, [address]);
  const notesError = useMemo(() => {
    if (notes.length > NOTES_MAX) return `Notes are at most ${NOTES_MAX} chars.`;
    return undefined;
  }, [notes]);

  const canSubmit =
    label.trim().length > 0 &&
    address.trim().length > 0 &&
    !labelError &&
    !addressError &&
    !notesError;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const err = await onSubmit({
      label: label.trim(),
      recipientAddress: address.trim(),
      notes: notes.trim().length > 0 ? notes.trim() : null,
      preApproved,
    });
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <form className="flex flex-col gap-4 rounded-lg border bg-card p-5" onSubmit={submit}>
      <h3 className="font-medium text-sm">New recipient</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Label"
          placeholder="Acme Corp"
          value={label}
          onChange={setLabel}
          error={labelError}
          help="Human pointer used in chat and approval cards."
          maxLength={LABEL_MAX}
          autoFocus
        />
        <TextField
          label="Recipient address"
          placeholder="Base58 Solana address"
          value={address}
          onChange={setAddress}
          error={addressError}
          help="Cannot be changed once saved — a new address is a new entry."
          mono
        />
      </div>
      <NotesField value={notes} onChange={setNotes} error={notesError} />
      <PreApprovedToggle value={preApproved} onChange={setPreApproved} />
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || saving} className="gap-1.5">
          {saving && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
          {saving ? 'Adding' : 'Add recipient'}
        </Button>
      </div>
    </form>
  );
}

function EntryRow({
  entry,
  onUpdate,
  onDelete,
  flash,
}: {
  entry: AddressBookEntryDto;
  onUpdate: (input: {
    label: string;
    notes: string | null;
    preApproved: boolean;
  }) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
  flash: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [label, setLabel] = useState(entry.label);
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [preApproved, setPreApproved] = useState(entry.preApproved);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the entry identity changes (e.g. server pushed an update), resync
  // the local edit baseline. Critical when the parent merges an updated
  // row in place — without this, an unrelated re-render with a fresh
  // entry would erase the user's in-flight edits.
  useEffect(() => {
    setLabel(entry.label);
    setNotes(entry.notes ?? '');
    setPreApproved(entry.preApproved);
    setError(null);
  }, [entry]);

  const labelError = useMemo(() => {
    const trimmed = label.trim();
    if (trimmed.length === 0) return 'Label is required.';
    if (trimmed.length > LABEL_MAX) return `Label is at most ${LABEL_MAX} chars.`;
    return undefined;
  }, [label]);
  const notesError = useMemo(() => {
    if (notes.length > NOTES_MAX) return `Notes are at most ${NOTES_MAX} chars.`;
    return undefined;
  }, [notes]);
  const dirty =
    label.trim() !== entry.label ||
    (notes.trim() || null) !== (entry.notes ?? null) ||
    preApproved !== entry.preApproved;

  const onSave = async () => {
    if (labelError || notesError) return;
    setSaving(true);
    setError(null);
    const err = await onUpdate({
      label: label.trim(),
      notes: notes.trim().length > 0 ? notes.trim() : null,
      preApproved,
    });
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      setEditing(false);
    }
  };

  const onConfirmDelete = async () => {
    setDeleting(true);
    setError(null);
    const err = await onDelete();
    setDeleting(false);
    if (err) {
      setError(err);
      setConfirmDelete(false);
    }
    // Success: parent already removed the row from `entries`; this
    // component will unmount.
  };

  return (
    <li
      className={cn(
        'flex flex-col gap-3 px-5 py-4 transition-colors',
        flash && 'bg-emerald-50/60 dark:bg-emerald-950/30',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          {editing ? (
            <TextField
              label="Label"
              value={label}
              onChange={setLabel}
              error={labelError}
              maxLength={LABEL_MAX}
              autoFocus
            />
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium text-sm" title={entry.label}>
                {entry.label}
              </h3>
              {entry.preApproved && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400">
                  <ShieldCheckIcon className="size-3" aria-hidden />
                  Pre-approved
                </span>
              )}
              {flash && (
                <span className="inline-flex items-center gap-1 text-emerald-600 text-[11px] dark:text-emerald-400">
                  <CheckCircle2Icon className="size-3" aria-hidden />
                  Saved
                </span>
              )}
            </div>
          )}
          <code
            className="truncate font-mono text-muted-foreground text-xs"
            title={entry.recipientAddress}
          >
            {truncateAddress(entry.recipientAddress)}
          </code>
          {!editing && entry.notes && (
            <p className="break-words text-muted-foreground text-xs">{entry.notes}</p>
          )}
        </div>
        {!editing && !confirmDelete && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${entry.label}`}
              className="size-8 p-0"
            >
              <PencilIcon className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${entry.label}`}
              className="size-8 p-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2Icon className="size-3.5" aria-hidden />
            </Button>
          </div>
        )}
        {confirmDelete && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-muted-foreground text-xs">Delete?</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onConfirmDelete}
              disabled={deleting}
              className="gap-1.5"
            >
              {deleting && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
              {deleting ? 'Removing' : 'Remove'}
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="flex flex-col gap-4 border-t pt-4">
          <NotesField value={notes} onChange={setNotes} error={notesError} />
          <PreApprovedToggle value={preApproved} onChange={setPreApproved} />
          {error && (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                // Revert edit state. Server values stay authoritative.
                setLabel(entry.label);
                setNotes(entry.notes ?? '');
                setPreApproved(entry.preApproved);
                setError(null);
                setEditing(false);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving || Boolean(labelError) || Boolean(notesError)}
              className="gap-1.5"
            >
              {saving && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
              {saving ? 'Saving' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  help,
  placeholder,
  maxLength,
  mono,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  help?: string;
  placeholder?: string;
  maxLength?: number;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          mono && 'font-mono',
          error && 'border-destructive focus-visible:ring-destructive',
        )}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
        {...(maxLength !== undefined && { maxLength })}
        autoFocus={autoFocus}
      />
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          {help}
        </p>
      ) : null}
    </div>
  );
}

function NotesField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        Notes
        <span className="ml-1.5 text-muted-foreground text-xs">(optional)</span>
      </label>
      <Textarea
        id={id}
        rows={2}
        placeholder="Vendor contact, payment cycle, etc."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(error && 'border-destructive focus-visible:ring-destructive')}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        maxLength={NOTES_MAX + 50 /* gentle browser cap; server enforces NOTES_MAX */}
      />
      <p className="text-muted-foreground text-xs">
        Shows up next to the recipient label in the settings list.
      </p>
      {error && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function PreApprovedToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onClick={() => onChange(!value)}
        className={cn(
          'mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          value ? 'border-primary bg-primary' : 'border-border bg-muted hover:bg-muted/80',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform',
            value ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <div className="flex flex-col gap-0.5">
        <span id={`${id}-label`} className="flex items-center gap-1.5 font-medium text-sm">
          <ShieldCheckIcon
            className={cn(
              'size-3.5',
              value ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
            )}
            aria-hidden
          />
          Pre-approve transfers to this recipient
        </span>
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          Transfers above your <span className="font-mono">requireApprovalAboveUsdc</span> cap skip
          the approval card when sent here. The 24h velocity budget still applies.
        </p>
      </div>
    </div>
  );
}

// Re-exported badge for future reuse (e.g. listing pre-approved set on
// a dashboard card). Kept here so the unique source of truth for the
// "pre-approved" visual is the address-book module.
export function PreApprovedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400">
      <CheckIcon className="size-3" aria-hidden />
      Pre-approved
    </span>
  );
}
