import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stem-Loops — Loops from anything.",
  description:
    "Paste a YouTube URL. Get perfect bar-aligned drum, bass, vocal, guitar, and keys loops. Free for your first three.",
  metadataBase: new URL("https://stem-loops.com"),
  openGraph: {
    title: "Stem-Loops",
    description: "Loops from anything. In seconds.",
    url: "https://stem-loops.com",
    siteName: "Stem-Loops",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
