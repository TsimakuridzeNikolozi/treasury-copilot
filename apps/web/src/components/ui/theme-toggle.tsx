'use client';

import { MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';

// Theme toggle. The mount guard avoids a hydration mismatch — on the
// server we don't know which theme the client will resolve to (system
// preference), so we render a sized placeholder until useEffect runs.
// Without this, next-themes' SSR output flickers on first paint.
export function ThemeToggle({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <IconButton size={size} aria-hidden tabIndex={-1} />;
  }

  const isDark = resolvedTheme === 'dark';
  return (
    <IconButton
      size={size}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
}
