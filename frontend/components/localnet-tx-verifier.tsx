'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Connection } from '@solana/web3.js'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type BackendConfig = {
  rpcUrl?: string
  ephemeralProviderUrl?: string | null
  network?: string
}

type VerifyResult =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'not_found' }
  | { state: 'error'; message: string }
  | {
      state: 'found'
      confirmationStatus: string | null
      err: string | null
      slot: number | null
    }

const DEFAULT_L1_ENDPOINT = 'http://127.0.0.1:8899'
const DEFAULT_PER_ENDPOINT = 'http://127.0.0.1:7799'

const normalizeEndpoint = (value: string) => value.trim().replace(/\/$/, '')

export default function LocalnetTxVerifier() {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'per' | 'l1'>('per')
  const [signature, setSignature] = useState('')
  const [l1Endpoint, setL1Endpoint] = useState(DEFAULT_L1_ENDPOINT)
  const [perEndpoint, setPerEndpoint] = useState(DEFAULT_PER_ENDPOINT)
  const [result, setResult] = useState<VerifyResult>({ state: 'idle' })
  const [loadingConfig, setLoadingConfig] = useState(false)

  const activeEndpoint = useMemo(
    () => (mode === 'per' ? perEndpoint : l1Endpoint),
    [mode, perEndpoint, l1Endpoint],
  )

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'F6' && event.shiftKey) {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const openHandler = () => setOpen(true)
    window.addEventListener('nebulon:open-tx-verifier', openHandler)
    return () => window.removeEventListener('nebulon:open-tx-verifier', openHandler)
  }, [])

  useEffect(() => {
    if (!open || loadingConfig) return
    setLoadingConfig(true)
    const loadConfig = async () => {
      try {
        const base = process.env.NEXT_PUBLIC_API_URL || '/api'
        const response = await fetch(`${base}/v1/config`)
        if (!response.ok) return
        const config: BackendConfig = await response.json()
        if (config.rpcUrl) {
          setL1Endpoint(normalizeEndpoint(config.rpcUrl))
        }
        if (config.ephemeralProviderUrl) {
          setPerEndpoint(normalizeEndpoint(config.ephemeralProviderUrl))
        }
        if (config.network?.toLowerCase() === 'localnet' && !config.ephemeralProviderUrl) {
          setPerEndpoint(DEFAULT_PER_ENDPOINT)
        }
      } catch {
        // Ignore config fetch failures; defaults still work for localnet.
      } finally {
        setLoadingConfig(false)
      }
    }
    loadConfig()
  }, [open, loadingConfig])

  const runVerify = async () => {
    const trimmed = signature.trim()
    if (!trimmed) {
      setResult({ state: 'error', message: 'Enter a transaction signature first.' })
      return
    }
    const endpoint = normalizeEndpoint(activeEndpoint)
    setResult({ state: 'loading' })
    try {
      const connection = new Connection(endpoint, 'confirmed')
      const statuses = await connection.getSignatureStatuses([trimmed], {
        searchTransactionHistory: true,
      })
      const entry = statuses?.value?.[0]
      if (!entry) {
        setResult({ state: 'not_found' })
        return
      }
      setResult({
        state: 'found',
        confirmationStatus: entry.confirmationStatus ?? null,
        err: entry.err ? JSON.stringify(entry.err) : null,
        slot: entry.slot ?? null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected error verifying transaction.'
      setResult({ state: 'error', message })
    }
  }

  const resetState = () => {
    setResult({ state: 'idle' })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (setOpen(next), resetState())}>
      <DialogContent className="max-w-xl bg-neutral-950 text-white border-neutral-800">
        <DialogHeader className="text-left">
          <DialogTitle>Solana Localnet Tx Verificator</DialogTitle>
          <DialogDescription className="text-neutral-400">
            Verify transaction signatures against localnet PER or localnet L1.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={mode === 'per' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('per')}
              className={mode === 'per' ? 'bg-indigo-500 text-white' : 'border-neutral-700'}
            >
              PER Localnet
            </Button>
            <Button
              variant={mode === 'l1' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('l1')}
              className={mode === 'l1' ? 'bg-emerald-500 text-white' : 'border-neutral-700'}
            >
              L1 Localnet
            </Button>
          </div>

          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-neutral-400">
              Transaction Signature
            </label>
            <Input
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              placeholder="Paste transaction signature"
              className="bg-neutral-900 border-neutral-800 text-white placeholder:text-neutral-500"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                PER RPC Endpoint
              </label>
              <Input
                value={perEndpoint}
                onChange={(event) => setPerEndpoint(event.target.value)}
                className="bg-neutral-900 border-neutral-800 text-white placeholder:text-neutral-500"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-neutral-400">
                L1 RPC Endpoint
              </label>
              <Input
                value={l1Endpoint}
                onChange={(event) => setL1Endpoint(event.target.value)}
                className="bg-neutral-900 border-neutral-800 text-white placeholder:text-neutral-500"
              />
            </div>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-4 text-sm text-neutral-300">
            {result.state === 'idle' && (
              <p>Pick a mode, paste a signature, then hit Verify.</p>
            )}
            {result.state === 'loading' && <p>Checking localnet status…</p>}
            {result.state === 'not_found' && (
              <p>Not found on {activeEndpoint}. Check the mode or endpoint.</p>
            )}
            {result.state === 'error' && <p>{result.message}</p>}
            {result.state === 'found' && (
              <div className="space-y-1">
                <div>
                  Status:{' '}
                  <span className="font-semibold text-white">
                    {result.confirmationStatus || 'unknown'}
                  </span>
                </div>
                <div>Slot: {result.slot ?? 'unknown'}</div>
                {result.err ? (
                  <div className="text-amber-300">Error: {result.err}</div>
                ) : (
                  <div className="text-emerald-300">No error reported.</div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="text-xs text-neutral-500">
            Shortcut: Shift + F6
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="border-neutral-700 text-neutral-200"
            >
              Close
            </Button>
            <Button onClick={runVerify} className="bg-white text-black hover:bg-neutral-100">
              Verify
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
