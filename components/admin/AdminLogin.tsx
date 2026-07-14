'use client'

import { useState } from 'react'

export default function AdminLogin({ hasPassword }: { hasPassword: boolean }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function login() {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || '登录失败')
      }
      location.reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-lg font-bold text-white">管理后台</h1>
        {hasPassword ? (
          <>
            <p className="mt-1 text-sm text-neutral-400">输入管理密码登录</p>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && login()}
              placeholder="管理密码"
              className="mt-4 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-400/50"
            />
            {err && <div className="mt-2 text-xs text-rose-400">{err}</div>}
            <button
              onClick={login}
              disabled={busy || !pw}
              className="mt-4 w-full rounded-xl bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--brand-bright)] disabled:opacity-50"
            >
              {busy ? '登录中…' : '登录'}
            </button>
          </>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-neutral-400">
            未设置管理密码。请在 <code className="text-neutral-200">.env</code> 配置{' '}
            <code className="text-neutral-200">ADMIN_PASSWORD</code>，或用被列入{' '}
            <code className="text-neutral-200">ADMIN_LINUXDO_IDS</code> 的 Linux.do 账号登录本站后访问。
          </p>
        )}
      </div>
    </main>
  )
}
