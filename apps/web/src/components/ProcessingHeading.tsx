import { processingHeading, type JobLabelFields } from '@/lib/job-label';

/**
 * The processing page's <h1> (QA A-04, 2026-11-18). The title once it is
 * known; until then a short host/ID form ("youtube.com · dQw4w9WgXcQ"), never
 * the raw URL. Any text that still has no break opportunity (a long unbroken
 * file name or title) wraps instead of running off both edges.
 */
export function ProcessingHeading({ job }: { job: Omit<JobLabelFields, 'id'> }) {
  const heading = processingHeading(job);
  return (
    <h1
      data-testid="job-heading"
      data-source={heading.isSource ? 'true' : undefined}
      style={{
        fontSize: heading.isSource ? 'var(--text-xl)' : 'var(--text-2xl)',
        margin: 0,
        textAlign: 'center',
        maxWidth: '100%',
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {heading.text}
    </h1>
  );
}
