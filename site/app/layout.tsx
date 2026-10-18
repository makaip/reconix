import type { Metadata, Viewport } from 'next'
import { Hanken_Grotesk } from 'next/font/google'
import './globals.css'

// One family for everything; hierarchy comes from size, weight, and tracking (see DESIGN.md).
// next/font self-hosts it at build time, so there is no runtime request to Google.
const sans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })

export const metadata: Metadata = {
  title: 'Reconix: an AI pentesting browser that waits for your approval',
  description:
    'Reconix is a pentesting browser with an AI copilot. The agent maps the attack surface and drafts payloads. Anything that changes state waits for your approval.',
  openGraph: {
    title: 'Reconix',
    description:
      'A pentesting browser with an AI copilot. Anything that changes state waits for your approval.',
    type: 'website'
  }
}

export const viewport: Viewport = { themeColor: '#0b0b0c' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  )
}
