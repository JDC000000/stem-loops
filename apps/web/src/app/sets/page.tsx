// /sets — the visitor's set lists (#322; Phase B, B2). The Demo set is listed signed out too.
import type { Metadata } from 'next';
import SetListsIndex from '@/components/setlists/SetListsIndex';

export const metadata: Metadata = { title: 'Set lists', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function SetsPage() {
  return <SetListsIndex />;
}
