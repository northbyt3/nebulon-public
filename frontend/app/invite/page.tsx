'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const extractToken = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    const inviteIndex = parts.findIndex((part) => part === 'invite');
    if (inviteIndex >= 0 && parts[inviteIndex + 1]) {
      return parts[inviteIndex + 1];
    }
    return parts[parts.length - 1] || '';
  } catch {
    const marker = '/invite/';
    if (trimmed.includes(marker)) {
      const token = trimmed.split(marker)[1] || '';
      return token.split(/[?#/]/)[0] || '';
    }
    return trimmed;
  }
};

export default function InviteEntryPage() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const token = extractToken(value);
    if (!token) {
      setError('Enter a valid invite link or code.');
      return;
    }
    setError('');
    router.push(`/invite/${token}`);
  };

  return (
    <div className="min-h-screen bg-dark-900">
      <main className="pt-24 pb-12 px-6">
        <div className="max-w-xl mx-auto">
          <div className="glass-panel rounded-2xl border border-white/5 p-8">
            <div className="text-center mb-8">
              <div className="w-14 h-14 bg-brand-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <iconify-icon icon="solar:mailbox-linear" className="text-brand-300" width="28" />
              </div>
              <h1 className="text-2xl font-semibold text-white">Enter Invite Code</h1>
              <p className="text-sm text-gray-400 mt-2">
                Paste an invite link or the contract code you received.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Invite Link or Code</label>
                <input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="e.g. 7kgcAhmwxiWBVko27o45SrWun1YP2WBNc"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-dark-800/60 px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-400"
                />
                {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold py-3 transition-colors"
              >
                Continue
              </button>
            </form>

            <div className="mt-6 text-center">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition-colors">
                Back to dashboard
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
