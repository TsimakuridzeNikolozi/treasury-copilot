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
import { AppNav } from '@/components/app-nav';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MODEL_PROVIDERS, type ModelProvider } from '@/lib/ai/model';
import { useChat } from '@ai-sdk/react';
import { usePrivy } from '@privy-io/react-auth';
import { DefaultChatTransport, type ToolUIPart } from 'ai';
import { CoinsIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT (OpenAI)',
};

const SUGGESTIONS: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: 'Show my positions', prompt: 'Show my positions across all venues.' },
  {
    title: 'Compare APYs',
    prompt: 'Compare the current supply APY for USDC on Kamino vs Save.',
  },
  {
    title: 'Rebalance 0.5 USDC',
    prompt: 'Rebalance 0.5 USDC from Save to Kamino.',
  },
];

interface ChatClientProps {
  // Server-resolved active treasury id; threaded into every chat request
  // body so the route can run the body-vs-cookie 409 check. Stale tabs
  // get a 409 → full reload to pick up the new id.
  activeTreasuryId: string;
}

export function ChatClient({ activeTreasuryId }: ChatClientProps) {
  const [provider, setProvider] = useState<ModelProvider>('anthropic');
  const [errorDismissed, setErrorDismissed] = useState(false);
  const { getAccessToken } = usePrivy();
  const router = useRouter();

  // `getAccessToken` and `router` are recreated on each parent render;
  // refs let us read the latest from inside the transport's closure
  // without retriggering the useState init.
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
        // error.message strings. The AI SDK's error surface might
        // change in future versions; a fetch override looks at the raw
        // status + body and is robust to that.
        //
        //   active_treasury_changed → multi-tab race, force reload to
        //                             pick up the new active treasury.
        //   no_active_treasury     → mid-bootstrap or revoked
        //                             membership; send the user to /.
        //   401 / 403              → bearer expired or rejected; bounce
        //                             to / so Privy's login flow can
        //                             refresh the token instead of
        //                             leaving the chat dead.
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

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background">
        <AppNav activeTreasuryId={activeTreasuryId} />

        {/* Sub-header: model selector + safety reminder. Sits below the global
            nav so the global nav stays consistent across pages. */}
        <div className="border-b bg-muted/30">
          <div className="mx-auto flex h-11 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
            <p className="hidden text-muted-foreground text-xs sm:block">
              Actions are gated by policy. Above-threshold proposals route to Telegram for human
              approval.
            </p>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground text-xs">Model</span>
                </TooltipTrigger>
                <TooltipContent>
                  Whichever model proposes, the policy engine is the only thing that decides.
                </TooltipContent>
              </Tooltip>
              <Select onValueChange={(v) => setProvider(v as ModelProvider)} value={provider}>
                <SelectTrigger className="w-[180px]" size="sm" aria-label="AI model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PROVIDER_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden">
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
                messages.map((m, mi) => (
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
                                {tp.input !== undefined && <ToolInput input={tp.input} />}
                                <ToolOutput errorText={tp.errorText} output={tp.output} />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                ))
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          {error && !errorDismissed && (
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
                className="-m-1 rounded p-1 hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                <XIcon className="size-4" />
              </button>
            </div>
          )}

          <div className="border-t bg-background p-4 sm:p-6">
            <PromptInput onSubmit={onSubmit}>
              <PromptInputTextarea placeholder='e.g. "rebalance 0.5 USDC from save to kamino"' />
              <PromptInputFooter>
                <span className="text-muted-foreground text-xs">
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    Enter
                  </kbd>{' '}
                  to send ·{' '}
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    Shift + Enter
                  </kbd>{' '}
                  for newline
                </span>
                <PromptInputSubmit status={status} />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
