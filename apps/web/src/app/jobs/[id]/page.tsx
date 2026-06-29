// Job progress/results page stub — Phase 1 implementation in T7
export default function JobPage({ params }: { params: { id: string } }) {
  return (
    <main>
      <h1>Job {params.id}</h1>
      <p>Loading job status...</p>
      {/* JobProgress + JobResults components added in Phase 1 T7 */}
    </main>
  )
}
