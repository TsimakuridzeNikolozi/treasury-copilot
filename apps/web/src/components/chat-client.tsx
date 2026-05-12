'use client';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { ChatSidebar, type SidebarSnapshot } from '@/components/chat/sidebar';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Mono } from '@/components/ui/mono';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UserMenu } from '@/components/user-menu';
import { MODEL_PROVIDERS, type ModelProvider } from '@/lib/ai/model';
import type { HistoryEntryDto } from '@/lib/dto/history';
import { useChat } from '@ai-sdk/react';
import { usePrivy } from '@privy-io/react-auth';
import { DefaultChatTransport, type ToolUIPart } from 'ai';
import { CoinsIcon, MenuIcon, ShieldIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

// Provider labels shown in the model picker. Whichever the user picks,
// the policy engine is still the only thing that decides actions —
// switching models doesn't widen the trust boundary.
const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT (OpenAI)',
};

const SUGGESTIONS: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: 'Show my positions', prompt: 'Show my positions across all venues.' },
  {
    title: 'Compare APYs',
    prompt: 'Compare the current supply APY for USDC on Kamino, Save, and Jupiter.',
  },
  {
    title: 'Rebalance 0.5 USDC',
    prompt: 'Rebalance 0.5 USDC from Save to Jupiter.',
  },
];

interface ChatClientProps {
  activeTreasuryId: string;
  treasuryName: string;
  telegramUsername: string | null;
  snapshot: SidebarSnapshot | null;
  recentHistory: ReadonlyArray<HistoryEntryDto>;
}

export function ChatClient({
  activeTreasuryId,
  treasuryName,
  telegramUsername,
  snapshot,
  recentHistory,
}: ChatClientProps) {
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [provider, setProvider] = useState<ModelProvider>('anthropic');
  const { getAccessToken } = usePrivy();
  const router = useRouter();

  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const routerRef = useRef(router);
  routerRef.current = router;

  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        headers: async (): Promise<Record<string, string>> => {
          const token = await getAccessTokenRef.current();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
        // 409 / 401 handling lives here, not in a useEffect that sniffs
        // error.message strings.
        fetch: async (url, init) => {
          const res = await fetch(url, init);
          if (res.status === 401 || res.status === 403) {
            routerRef.current.replace('/');
            return res;
          }
          if (res.status === 409) {
            const body = (await res
              .clone()
              .json()
              .catch(() => null)) as { error?: string } | null;
            if (body?.error === 'active_treasury_changed') {
              window.location.reload();
            } else if (body?.error === 'no_active_treasury') {
              routerRef.current.replace('/');
            }
          }
          return res;
        },
      }),
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  // Refresh the server-rendered sidebar (snapshot + recent history) after
  // each AI turn finishes streaming. Triggers only on the 'ready'
  // transition so we don't refetch on every token.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current !== 'ready' && status === 'ready' && messages.length > 0) {
      routerRef.current.refresh();
    }
    prevStatusRef.current = status;
  }, [status, messages.length]);

  const onSubmit = (msg: PromptInputMessage) => {
    const text = msg.text.trim();
    if (!text) return;
    setErrorDismissed(false);
    sendMessage({ text }, { body: { provider, treasuryId: activeTreasuryId } });
  };

  const onSuggest = (prompt: string) => {
    setErrorDismissed(false);
    sendMessage({ text: prompt }, { body: { provider, treasuryId: activeTreasuryId } });
  };

  // Conversation title: first user message truncated, else placeholder.
  const firstUserText =
    messages
      .find((m) => m.role === 'user')
      ?.parts.find((p) => p.type === 'text')
      ?.text?.trim() ?? '';
  const conversationTitle = firstUserText
    ? firstUserText.length > 60
      ? `${firstUserText.slice(0, 60)}…`
      : firstUserText
    : 'New action';

  return (
    <div className="flex h-screen w-full bg-background">
      <ChatSidebar
        activeTreasuryId={activeTreasuryId}
        treasuryName={treasuryName}
        telegramUsername={telegramUsername}
        snapshot={snapshot}
        recentHistory={recentHistory}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <IconButton
              size="md"
              aria-label="Open sidebar"
              onClick={() => setMobileOpen(true)}
              className="md:hidden"
            >
              <MenuIcon />
            </IconButton>
            <span className="truncate font-medium text-sm text-foreground">
              {conversationTitle}
            </span>
            <Mono className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
              ·{' '}
              {new Date().toLocaleDateString('en-US', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </Mono>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <Select onValueChange={(v) => setProvider(v as ModelProvider)} value={provider}>
              <SelectTrigger
                size="sm"
                aria-label="AI model"
                className="w-auto gap-1.5 sm:w-[170px]"
              >
                <span className="hidden sm:inline">
                  <SelectValue />
                </span>
                {/* Compact mobile label — the trigger still renders the full
                    value via the hidden SelectValue above for assistive tech,
                    but the visible chip stays short so the header doesn't
                    overflow on narrow viewports. */}
                <span className="font-mono text-[11px] sm:hidden">
                  {provider === 'anthropic' ? 'Claude' : 'GPT'}
                </span>
              </SelectTrigger>
              <SelectContent align="end">
                {MODEL_PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <UserMenu />
          </div>
        </header>

        {/* Thin mobile balance bar — when sidebar is closed users still
            see the bottom-line number for context. md:hidden on desktop. */}
        <div className="border-b bg-muted/30 px-4 py-2 md:hidden">
          <Mono className="text-xs text-foreground">
            ${snapshot?.totalUsdc ?? '—'}
            <span className="ml-2 text-muted-foreground">
              {snapshot?.blendedApyPct ? `· ${snapshot.blendedApyPct} APY` : '· USDC'}
            </span>
          </Mono>
        </div>

        <Conversation>
          <ConversationContent>
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-6 py-12">
                <ConversationEmptyState
                  description="Ask in plain English. The agent proposes, the policy decides, the signer executes."
                  icon={<CoinsIcon className="size-8" />}
                  title="Treasury Copilot is ready"
                />
                <div className="flex w-full flex-col items-center gap-2">
                  <span className="text-muted-foreground text-xs uppercase tracking-wide">
                    Try one of these
                  </span>
                  <div className="flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((s) => (
                      <Button
                        key={s.title}
                        variant="outline"
                        size="sm"
                        onClick={() => onSuggest(s.prompt)}
                        className="gap-1.5"
                      >
                        <SparklesIcon className="size-3.5" aria-hidden />
                        {s.title}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {messages.map((m, mi) => (
                  <Message from={m.role} key={`${m.id}-${mi}`}>
                    <MessageContent>
                      {m.parts.map((part, i) => {
                        const key = `${m.id}-${mi}-${i}`;
                        if (part.type === 'text') {
                          return (
                            <p className="whitespace-pre-wrap" key={key}>
                              {part.text}
                            </p>
                          );
                        }
                        if (part.type.startsWith('tool-')) {
                          const tp = part as ToolUIPart;
                          return (
                            <Tool defaultOpen key={key}>
                              <ToolHeader state={tp.state} type={tp.type} />
                              <ToolContent>
                                {tp.input !== undefined ? <ToolInput input={tp.input} /> : null}
                                <ToolOutput errorText={tp.errorText} output={tp.output} />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                ))}

                {showTypingIndicator(status, messages) ? (
                  <Message from="assistant">
                    <MessageContent>
                      <TypingIndicator />
                    </MessageContent>
                  </Message>
                ) : null}
              </>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {error && !errorDismissed ? (
          <div
            role="alert"
            className="flex items-start gap-2 border-t bg-destructive/10 px-4 py-3 text-destructive text-sm sm:px-6"
          >
            <span className="flex-1 leading-snug">
              <span className="font-medium">Something went wrong.</span> {error.message}
            </span>
            <button
              type="button"
              onClick={() => setErrorDismissed(true)}
              aria-label="Dismiss error"
              className="-m-1 rounded p-1 hover:bg-destructive/15"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        ) : null}

        <div className="border-t bg-background p-4 sm:p-6">
          <PromptInput onSubmit={onSubmit}>
            <PromptInputTextarea placeholder='e.g. "rebalance 0.5 USDC from save to jupiter"' />
            <PromptInputFooter>
              <span className="flex items-center gap-3 text-muted-foreground text-xs">
                <span>
                  <Mono className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">↵</Mono> send
                </span>
                <span>
                  <Mono className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">⇧↵</Mono>{' '}
                  newline
                </span>
                <span className="hidden items-center gap-1 sm:flex">
                  <ShieldIcon className="size-3" aria-hidden /> Policy enforced at proposal
                </span>
              </span>
              <PromptInputSubmit status={status} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </main>
    </div>
  );
}

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error' | (string & {});
type ChatMessage = { role: string; parts: { type: string; text?: string }[] };

function showTypingIndicator(status: ChatStatus, messages: ChatMessage[]): boolean {
  if (status === 'submitted') return true;
  if (status !== 'streaming') return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return true;
  const hasContent = last.parts.some(
    (p) =>
      (p.type === 'text' && typeof p.text === 'string' && p.text.length > 0) ||
      p.type.startsWith('tool-'),
  );
  return !hasContent;
}

function TypingIndicator() {
  return (
    <output
      className="flex h-5 items-center gap-1.5"
      aria-live="polite"
      aria-label="Generating response"
    >
      <span className="sr-only">Generating response…</span>
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-muted-foreground animate-[typing-bounce_1.2s_ease-in-out_infinite]"
      />
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-muted-foreground animate-[typing-bounce_1.2s_ease-in-out_infinite] [animation-delay:0.15s]"
      />
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-muted-foreground animate-[typing-bounce_1.2s_ease-in-out_infinite] [animation-delay:0.3s]"
      />
    </output>
  );
}
