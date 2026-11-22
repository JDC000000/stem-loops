// /sets/[id] — one set list, or the read-only Demo set at /sets/demo (#322; Phase B, B2).
// Ownership is the API's (GET /api/set-lists/:id, owner-scoped): this page holds no data.
import type { Metadata } from 'next';
import SetListView from '@/components/setlists/SetListView';

export const metadata: Metadata = { title: 'Set list', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function SetPage({ params }: { params: { id: string } }) {
  return <SetListView id={params.id} />;
}
