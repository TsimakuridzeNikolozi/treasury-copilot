'use client';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { env } from '@/env';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { CheckCircle2Icon, CheckIcon, ChevronDownIcon, CopyIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

// Same regex shapes as the server route. Mirroring here so the user sees
// a red border / inline message before the round-trip — server is still
// the source of truth.
const CHAT_ID_REGEX = /^(-?\d+|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const APPROVER_ID_REGEX = /^\d+$/;

interface FormState {
  // Empty string is the "no chat configured" case in the UI; serialised to
  // `null` on submit. Storing as string keeps the controlled <input> simple.
  telegramChatId: string;
  // One id per line in the textarea. Trimmed/filtered on submit.
  telegramApproverIdsRaw: string;
}

function fromInitial(initial: {
  telegramChatId: string | null;
  telegramApproverIds: string[];
}): FormState {
  return {
    telegramChatId: initial.telegramChatId ?? '',
    telegramApproverIdsRaw: initial.telegramApproverIds.join('\n'),
  };
}

function parseApproverIds(raw: string): string[] {
  // Dedupe — pasting `123\n456\n123` from a sloppy source shouldn't double up
  // the same approver in the stored list. Set preserves first-occurrence
  // order in JS, so the displayed-vs-saved mapping is stable.
  return Array.from(
    new Set(
      raw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export function TelegramConfigForm({
  initial,
  treasuryId,
}: {
  initial: { telegramChatId: string | null; telegramApproverIds: string[] };
  treasuryId: string;
}) {
  const { getAccessToken } = usePrivy();

  // Same dual-state pattern as PolicyForm: `state` is what the user sees
  // and edits; `baseline` is what we last persisted, used for dirty
  // detection. A successful save snaps `baseline` forward.
  const [state, setState] = useState<FormState>(() => fromInitial(initial));
  const [baseline, setBaseline] = useState<FormState>(() => fromInitial(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Defense-in-depth re-sync if a future change re-renders the form in place
  // with a new treasury (no current path does this; the switcher reloads).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only treasuryId / initial identity should re-init.
  useEffect(() => {
    const fresh = fromInitial(initial);
    setState(fresh);
    setBaseline(fresh);
    setError(null);
    setSavedAt(null);
  }, [treasuryId, initial]);

  const dirty = useMemo(
    () =>
      state.telegramChatId !== baseline.telegramChatId ||
      state.telegramApproverIdsRaw !== baseline.telegramApproverIdsRaw,
    [state, baseline],
  );

  const chatIdError = useMemo(() => {
    const trimmed = state.telegramChatId.trim();
    if (!trimmed) return undefined;
    return CHAT_ID_REGEX.test(trimmed)
      ? undefined
      : 'Use a numeric chat id (e.g. -1001234567890) or @channel_username.';
  }, [state.telegramChatId]);

  const approverErrors = useMemo(() => {
    const ids = parseApproverIds(state.telegramApproverIdsRaw);
    const bad = ids.filter((id) => !APPROVER_ID_REGEX.test(id));
    if (bad.length === 0) return undefined;
    return `Not numeric Telegram user ids: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`;
  }, [state.telegramApproverIdsRaw]);

  const blocking = Boolean(chatIdError) || Boolean(approverErrors);

  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 4000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const trimmed = state.telegramChatId.trim();
      const res = await fetch('/api/treasury/telegram-config', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          treasuryId,
          telegramChatId: trimmed.length === 0 ? null : trimmed,
          telegramApproverIds: parseApproverIds(state.telegramApproverIdsRaw),
        }),
      });
      // 409 mirrors the chat / policy routes: stale tab vs. another window
      // changed the active treasury, or the active treasury is gone.
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'no_active_treasury') {
          window.location.replace('/');
          return;
        }
        window.location.reload();
        return;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `${res.status} ${res.statusText}`);
      }
      // Snap baseline forward; the server returns 204 (no body) so we
      // trust our submitted shape until next page load.
      setBaseline(state);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !blocking) onSave();
      }}
    >
      <Section
        title="Telegram approval routing"
        description="Where approval cards land for this treasury, and which Telegram user ids may approve them."
      >
        {/* Setup guide collapses by default once the form is configured —
            opening it again is a single click for someone tweaking later.
            First-time users land with both fields empty, so it auto-opens
            and walks them through the Telegram bot dance step by step. */}
        <SetupGuide
          defaultOpen={!initial.telegramChatId && initial.telegramApproverIds.length === 0}
        />
        <ChatIdField
          value={state.telegramChatId}
          onChange={(v) => setState((cur) => ({ ...cur, telegramChatId: v }))}
          error={chatIdError}
        />
        <ApproverIdsField
          value={state.telegramApproverIdsRaw}
          onChange={(v) => setState((cur) => ({ ...cur, telegramApproverIdsRaw: v }))}
          error={approverErrors}
        />
      </Section>

      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border bg-card/95 p-3 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/80">
        <p className="text-muted-foreground text-xs">
          {dirty ? <span className="text-foreground">Unsaved changes</span> : 'Saved'}
        </p>
        <div className="flex items-center gap-3">
          {savedAt && !error && (
            <span className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
              <CheckCircle2Icon className="size-3.5" aria-hidden /> Saved
            </span>
          )}
          {error && (
            <span className="max-w-[20rem] truncate text-destructive text-xs" title={error}>
              {error}
            </span>
          )}
          <Button type="submit" disabled={!dirty || saving || blocking} className="gap-1.5">
            {saving && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
            {saving ? 'Saving' : 'Save changes'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="border-b px-5 py-3.5">
        <h2 className="font-medium text-sm">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>
      </header>
      <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
    </section>
  );
}

function ChatIdField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        Telegram chat id
      </label>
      <Input
        id={id}
        type="text"
        placeholder="e.g. -1001234567890"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(error && 'border-destructive focus-visible:ring-destructive')}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <p className="text-muted-foreground text-xs">
        Negative number for private groups, or <code className="font-mono">@channel_username</code>.
        Leave empty to park require-approval actions until configured.
      </p>
      {error && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function ApproverIdsField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        Approver Telegram user ids
      </label>
      <Textarea
        id={id}
        rows={4}
        placeholder={'123456789\n987654321'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'font-mono text-sm',
          error && 'border-destructive focus-visible:ring-destructive',
        )}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <p className="text-muted-foreground text-xs">
        One numeric user id per line. Approvers without an id in this list see “Not authorized” when
        they tap a button.
      </p>
      {error && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

// Setup guide — collapsible disclosure walking the owner through the four
// Telegram steps. Defaults to open the first time (when both fields are
// empty) and collapsed once configured. The radix Collapsible primitive
// adds `data-state="open|closed"` to both trigger and content, which we
// hook into for the chevron rotation animation.
function SetupGuide({ defaultOpen }: { defaultOpen: boolean }) {
  const botUsername = env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-md border bg-muted/30">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-md px-4 py-2.5',
          'text-left text-sm transition-colors hover:bg-muted/60',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        <span className="flex items-center gap-2">
          <span aria-hidden className="font-medium text-muted-foreground">
            ?
          </span>
          <span className="font-medium">Setup guide</span>
          <span className="text-muted-foreground text-xs">— first-time setup in 4 steps</span>
        </span>
        <ChevronDownIcon
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-none">
        <ol className="flex flex-col gap-4 border-t px-4 py-4">
          <Step n={1} title="Add the bot to your Telegram group">
            <BotUsernameRow username={botUsername} />
          </Step>

          <Step n={2} title="Find your group's chat id">
            <p className="text-muted-foreground text-sm leading-relaxed">
              Add{' '}
              <code className="rounded bg-muted px-1 font-mono text-foreground">@raw_data_bot</code>{' '}
              to the same group. It posts a JSON dump — copy the{' '}
              <code className="rounded bg-muted px-1 font-mono text-foreground">chat.id</code> value
              (a negative number like <code className="font-mono">-1001234567890</code>). Then
              remove{' '}
              <code className="rounded bg-muted px-1 font-mono text-foreground">@raw_data_bot</code>{' '}
              from the group.
            </p>
          </Step>

          <Step n={3} title="Find each approver's user id">
            <p className="text-muted-foreground text-sm leading-relaxed">
              Each approver opens{' '}
              <code className="rounded bg-muted px-1 font-mono text-foreground">@userinfobot</code>{' '}
              in Telegram and sends <code className="font-mono">/start</code>. It replies with their
              numeric id.
            </p>
          </Step>

          <Step n={4} title="Paste both below and save">
            <p className="text-muted-foreground text-sm leading-relaxed">
              Drop the chat id in the first field, the approver ids one per line in the textarea,
              then click <span className="font-medium text-foreground">Save changes</span>.
            </p>
          </Step>
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground font-medium text-background text-xs tabular-nums"
      >
        {n}
      </span>
      <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
        <span className="font-medium text-sm">{title}</span>
        {children}
      </div>
    </li>
  );
}

// Bot @username display + copy. Falls back to a generic instruction when
// NEXT_PUBLIC_TELEGRAM_BOT_USERNAME isn't configured — the user still
// knows what they're looking for, just doesn't get one-click copy.
function BotUsernameRow({ username }: { username: string | undefined }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!username) {
    return (
      <p className="text-muted-foreground text-sm leading-relaxed">
        Open Telegram, search for the bot you were given, and add it to a private group you control.
        Ask your operator if you don't have the bot's @username.
      </p>
    );
  }

  const handle = `@${username}`;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(handle);
      setCopied(true);
    } catch {
      // Clipboard can fail (insecure context, denied permission). The
      // value is still selectable via the visible <code> block.
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="rounded bg-background px-2 py-1 font-mono text-sm">{handle}</code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied bot username' : 'Copy bot username'}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        {copied ? (
          <>
            <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span aria-live="polite" className="text-emerald-600 dark:text-emerald-400">
              Copied
            </span>
          </>
        ) : (
          <>
            <CopyIcon className="size-3.5" aria-hidden />
            <span>Copy</span>
          </>
        )}
      </button>
      <span className="text-muted-foreground text-sm">— add it to your approval group.</span>
    </div>
  );
}
