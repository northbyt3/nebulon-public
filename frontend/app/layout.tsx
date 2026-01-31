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
  title: 'Nebulon - Private Escrow for Web3 Deals',
  description: 'A Solana escrow protocol with milestone approvals, dispute resolution, and private deal details using MagicBlock PER. Never get scammed again.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
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
