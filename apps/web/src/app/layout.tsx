import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'stem-loops — YouTube to stem loops',
  description: 'Turn any YouTube song into bar-aligned stem loops for your DAW',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
