'use client';

import { env } from '@/env';
import { PrivyProvider as PrivyProviderRaw } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

// M1 keeps the modal minimal: email OTP only. Wallet linking + embedded-
// wallet provisioning land in M2 with the per-user Turnkey sub-org flow —
// surfacing them now would put a "connect wallet" option in the modal that
// does nothing useful.
export function PrivyProvider({ children }: { children: ReactNode }) {
  return (
    <PrivyProviderRaw
      appId={env.NEXT_PUBLIC_PRIVY_APP_ID}
      config={{
        loginMethods: ['email'],
        appearance: { theme: 'light' },
      }}
    >
      {children}
    </PrivyProviderRaw>
  );
}
