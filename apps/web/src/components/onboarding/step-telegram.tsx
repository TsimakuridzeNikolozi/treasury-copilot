'use client';

import type { WizardTreasury } from '@/app/onboarding/onboarding-client';
import { TelegramConfigForm } from '@/components/telegram-config-form';

// Step 4 — Telegram approval routing.
//
// Reuses TelegramConfigForm in its embedded mode (`onSkip` + `onSaved`
// callbacks turn the sticky save bar into Skip / Save & continue).
// First-time users land with both fields empty, so the form's setup
// guide auto-opens and walks them through the bot dance.
//
// Skip is allowed: small treasuries running auto-approve-only don't
// need Telegram. The wizard advances either way; users can revisit
// from /settings later.

export function StepTelegram({
  treasury,
  onAdvance,
}: {
  treasury: WizardTreasury;
  onAdvance: () => void;
}) {
  return (
    <section className="flex flex-col gap-6 rounded-xl border bg-card p-6 sm:gap-8 sm:p-8">
      <header className="flex flex-col gap-2 text-center">
        <h2 className="font-semibold text-2xl tracking-tight">Telegram approval</h2>
        <p className="mx-auto max-w-md text-balance text-muted-foreground text-sm">
          Where above-threshold actions land for human approval. Skip if you're auto-approve only —
          you can configure this later in Settings.
        </p>
      </header>
      <TelegramConfigForm
        initial={{ telegramChatId: null, telegramApproverIds: [] }}
        treasuryId={treasury.id}
        onSaved={onAdvance}
        onSkip={onAdvance}
      />
    </section>
  );
}
