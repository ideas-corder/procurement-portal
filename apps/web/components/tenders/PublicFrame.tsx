import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSession } from '../../lib/session';

/** Where suppliers register: the public onboarding app. */
export const ONBOARDING_URL = (process.env.NEXT_PUBLIC_ONBOARDING_URL || 'http://localhost:33004').replace(/\/+$/, '');

/** Chrome for the public tender pages: a light top bar, no sidebar, no login needed. */
export default function PublicFrame({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const isVendor = session?.user?.role === 'vendor';
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="tp-topbar">
        <Link href="/open-tenders" className="tp-brand">
          <span className="brand-logo" style={{ width: 30, height: 30, fontSize: 14 }}>P</span>
          PakBoxes Tenders
        </Link>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isVendor ? (
            <Link href="/supplier/tenders" className="btn sm primary">My supplier dashboard</Link>
          ) : session ? (
            <Link href="/dashboard" className="btn sm">Back to the portal</Link>
          ) : (
            <>
              <a href={ONBOARDING_URL} className="btn sm ghost" data-register-link="">Register as supplier</a>
              <Link href="/?next=%2Fsupplier%2Ftenders" className="btn sm primary">Supplier sign in</Link>
            </>
          )}
        </div>
      </div>
      <div className="tp-public-wrap">{children}</div>
    </div>
  );
}
