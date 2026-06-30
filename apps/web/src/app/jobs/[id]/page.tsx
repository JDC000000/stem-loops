import { notFound } from 'next/navigation';

interface JobPageProps {
  params: { id: string };
}

async function getJob(id: string) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const res = await fetch(`${baseUrl}/api/jobs/${id}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

export default async function JobPage({ params }: JobPageProps) {
  const job = await getJob(params.id);

  if (!job) {
    notFound();
  }

  return (
    <main style={{ maxWidth: 640, margin: '80px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Job Status</h1>
      <p><strong>ID:</strong> {job.id}</p>
      <p><strong>Status:</strong> {job.status}</p>
      <p><strong>URL:</strong> {job.source_url}</p>
      {job.error_code && (
        <p style={{ color: 'red' }}><strong>Error:</strong> {job.error_code}</p>
      )}
      {job.status === 'done' && job.loops && (
        <section>
          <h2>Loops</h2>
          <ul>
            {job.loops.map((loop: { id: string; stem: string; loop_length_bars: number; r2_url: string }) => (
              <li key={loop.id}>
                {loop.stem} — {loop.loop_length_bars} bars
                {' '}<a href={loop.r2_url} target="_blank" rel="noopener noreferrer">[download]</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
