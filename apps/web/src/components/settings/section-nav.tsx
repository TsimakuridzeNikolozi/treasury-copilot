'use client';

import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useEffect, useState } from 'react';

// Sticky scroll-spy nav for the settings sections. Desktop renders as a
// vertical rail to the left of the form column; mobile collapses to a
// horizontal sticky tab strip above the content. IntersectionObserver
// tracks which section is in view so the active style updates as the
// user scrolls instead of only after they click a link.
//
// The link hrefs use `#anchor` fragments so the URL is shareable + the
// page hits standard anchor scroll behavior. We don't preventDefault on
// click — the browser handles the scroll, the observer updates the
// active state for us.
export function SettingsSectionNav({
  sections,
}: {
  sections: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [active, setActive] = useState(sections[0]?.id ?? '');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    // rootMargin offsets the trigger to the middle of the viewport so a
    // section becomes "active" once its top crosses ~30% from the top of
    // the screen — feels right next to a sticky header. The top
    // negative margin matches the AppShell header height (56px) so
    // sticky elements don't trigger an immediate flip.
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the topmost intersecting section. Multiple may overlap
        // at small viewport sizes.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: 0 },
    );

    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  return (
    // Mobile: sticky horizontal tab strip pinned just below the AppShell
    // header (h-14). The component is rendered outside the padded page
    // container so it is naturally full-viewport-width — no negative
    // margins required (they caused page-level horizontal overflow on
    // Safari). `px-4 sm:px-6` aligns the pills with the page content.
    // Desktop (lg): sticky vertical rail to the left of the content;
    // the mobile chrome (border, bg, blur) resets via `lg:` utilities.
    <nav
      aria-label="Settings sections"
      className="sticky top-14 z-20 border-b bg-background/85 px-4 backdrop-blur sm:px-6 lg:top-20 lg:z-auto lg:self-start lg:border-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none"
    >
      <ul className="flex gap-1 overflow-x-auto py-1.5 lg:flex-col lg:py-0">
        {sections.map((s) => {
          const isActive = active === s.id;
          return (
            <li key={s.id} className="shrink-0 lg:w-full">
              <Link
                href={`#${s.id}`}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors lg:px-2.5',
                  isActive
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
