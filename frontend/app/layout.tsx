import React from "react"
import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { WalletContextProvider } from '@/lib/wallet-context'
import { Toaster } from '@/components/ui/toaster'
import { ToastHotkeys } from '@/components/toast-hotkeys'
import LocalnetTxVerifier from '@/components/localnet-tx-verifier'
import Script from 'next/script'
import './globals.css'
import '@solana/wallet-adapter-react-ui/styles.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: 'Nebulon - Private Escrow for Web3 Deals',
    template: '%s | Nebulon',
  },
  description:
    'Nebulon is a private, milestone-based escrow on Solana with on-chain enforcement and dispute resolution, powered by MagicBlock.',
  metadataBase: new URL('https://nebulon-five.vercel.app'),
  openGraph: {
    type: 'website',
    url: 'https://nebulon-five.vercel.app',
    siteName: 'Nebulon',
    title: 'Nebulon - Private Escrow for Web3 Deals',
    description:
      'Nebulon is a private, milestone-based escrow on Solana with on-chain enforcement and dispute resolution, powered by MagicBlock.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Nebulon',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nebulon - Private Escrow for Web3 Deals',
    description:
      'Nebulon is a private, milestone-based escrow on Solana with on-chain enforcement and dispute resolution, powered by MagicBlock.',
    images: ['/og-image.png'],
  },
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`font-sans antialiased`}>
        <WalletContextProvider>
          {children}
          <Toaster />
          <ToastHotkeys />
          <LocalnetTxVerifier />
        </WalletContextProvider>
        <Script src="https://code.iconify.design/iconify-icon/1.0.7/iconify-icon.min.js" strategy="afterInteractive" />
        <Analytics />
      </body>
    </html>
  )
}
