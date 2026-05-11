import { PrivyProvider } from '@/components/privy-provider';
import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Manrope } from 'next/font/google';
import './globals.css';
import './../env';

// Brand: "Inference" palette (cyan, minimal · technical) + Manrope/JetBrains Mono
// pairing — sharp geometric sans for body/headings, mono for tabular numbers,
// addresses, and code. Wired via next/font/google so Next inlines the font
// files at build time (no FOUT, no runtime fetch). See brand.md at the repo
// root for the full system.
const sans = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Treasury Copilot',
  description: 'Chat-first AI agent managing USDC across Solana yield venues.',
};

// oklch(0.99 0 0) ≈ #FAFAFA  oklch(0.1 0 0) ≈ #1A1A1A
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1a1a' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <PrivyProvider>{children}</PrivyProvider>
      </body>
    </html>
  );
}
