import type { Metadata } from 'next';
import './globals.css';
// (your font imports here)
import { Analytics } from '@vercel/analytics/react';
import { track } from '@vercel/analytics';

export const metadata: Metadata = {
  title: 'Unreal AI Image Generator',
  description: 'Print-ready generator',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#3A3B3D]">
        {children}
        <Analytics />   {/* ← add this just before </body> */}
      </body>
    </html>
  );
}
