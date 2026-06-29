import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'stem-loops — YouTube to stem loops',
  description: 'Turn any YouTube song into bar-aligned stem loops for your DAW',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
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
