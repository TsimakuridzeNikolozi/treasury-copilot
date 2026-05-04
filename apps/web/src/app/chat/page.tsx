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
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MODEL_PROVIDERS, type ModelProvider } from '@/lib/ai/model';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type ToolUIPart } from 'ai';
import { CoinsIcon } from 'lucide-react';
import { useState } from 'react';

const SESSION_ID = 'dev-session';

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'GPT (OpenAI)',
  qvac: 'QVAC (local)',
};

// Module-scoped: useChat captures the transport on mount and does not re-bind
// when its prop identity changes. A stable transport plus per-call body in
// sendMessage(...) is the supported way to vary request fields at runtime.
const transport = new DefaultChatTransport({
  api: '/api/chat',
  body: { sessionId: SESSION_ID },
});

export default function ChatPage() {
  const [provider, setProvider] = useState<ModelProvider>('anthropic');

  const { messages, sendMessage, status, error } = useChat({ transport });

  const onSubmit = (msg: PromptInputMessage) => {
    const text = msg.text.trim();
    if (!text) return;
    sendMessage({ text }, { body: { provider } });
  };

  return (
    <TooltipProvider>
      <main className="mx-auto flex h-screen max-w-3xl flex-col">
        <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
          <div>
            <h1 className="font-semibold text-lg">Treasury Copilot</h1>
            <p className="text-muted-foreground text-xs">
              Chat-first USDC ops across Solana yield venues
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select onValueChange={(v) => setProvider(v as ModelProvider)} value={provider}>
              <SelectTrigger className="w-[180px]" size="sm">
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
            <Badge className="font-mono text-xs" variant="outline">
              {SESSION_ID}
            </Badge>
          </div>
        </header>

        <Conversation>
          <ConversationContent>
            {messages.length === 0 ? (
              <ConversationEmptyState
                description='Try: "deposit 500 USDC into Kamino from So111…"'
                icon={<CoinsIcon className="size-8" />}
                title="No messages yet"
              />
            ) : (
              messages.map((m) => (
                <Message from={m.role} key={m.id}>
                  <MessageContent>
                    {m.parts.map((part, i) => {
                      const key = `${m.id}-${i}`;
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

        {error && (
          <div className="border-t bg-destructive/10 px-6 py-3 text-destructive text-sm">
            {error.message}
          </div>
        )}

        <div className="border-t p-4">
          <PromptInput onSubmit={onSubmit}>
            <PromptInputTextarea placeholder='e.g. "rebalance 2000 USDC from kamino to drift"' />
            <PromptInputFooter>
              <span className="text-muted-foreground text-xs">
                Actions are gated by policy. No funds move without execution.
              </span>
              <PromptInputSubmit status={status} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </main>
    </TooltipProvider>
  );
}
