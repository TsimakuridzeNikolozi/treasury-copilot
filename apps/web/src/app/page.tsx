import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Treasury Copilot</h1>
      <p className="text-muted-foreground max-w-md text-center">
        Chat-first AI agent for Solana yield management.
      </p>
      <Link href="/chat" className="rounded bg-foreground px-4 py-2 text-background">
        Open chat
      </Link>
    </main>
  );
}
