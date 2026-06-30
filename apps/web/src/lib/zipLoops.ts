// Loop-pack ZIP download (P3-6) — fetches each loop's signed URL and bundles them
// with the canonical filenames into one zip, all client-side (no server round-trip).
import JSZip from 'jszip';

type ZipLoop = { signed_url?: string | null; filename: string };

export async function downloadLoopPack(loops: ZipLoop[], title: string): Promise<void> {
  const zip = new JSZip();
  await Promise.all(
    loops
      .filter((l) => l.signed_url)
      .map(async (loop) => {
        const resp = await fetch(loop.signed_url as string);
        zip.file(loop.filename, await resp.blob());
      }),
  );
  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}-loops.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
