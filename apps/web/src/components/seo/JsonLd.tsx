// SEO-05. Server component. A JSON-LD script is not executed, so the CSP does not apply to it.
export function JsonLd({ data }: { data: object }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c'); // a string can never close the tag
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
