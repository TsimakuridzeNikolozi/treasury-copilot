import type { Metadata } from 'next';
import './globals.css';
import './../env';

export const metadata: Metadata = {
  title: 'Treasury Copilot',
  description: 'Chat-first AI agent managing USDC across Solana yield venues.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
