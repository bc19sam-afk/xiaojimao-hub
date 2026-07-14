'use client'

import { useEffect, useRef, useState } from 'react'
import { GiftIcon, CaretRightIcon, KeyIcon, ArrowSquareOutIcon } from '@phosphor-icons/react'
import { OpenAIMark } from './OpenAIMark'

type Toast = { title: string; desc: string; ok: boolean } | null
type Provider = 'codex' | 'claude' | 'grok'

const PROVIDERS: { id: Provider; name: string; sub: string }[] = [
  { id: 'codex', name: 'ChatGPT', sub: 'Plus / Pro / Team / K12' },
  { id: 'claude', name: 'Claude', sub: 'Claude 订阅' },
  { id: 'grok', name: 'Grok', sub: 'SuperGrok' },
]

const inputCls =
  'w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-emerald-400/50'

export default function CollectPanel({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<Provider>('codex')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<{ url: string; state: string; flow: 'redirect' | 'device'; userCode?: string } | null>(null)
  const [callback, setCallback] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [rt, setRt] = useState('')
  const [toast, setToast] = useState<Toast>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reset = () => {
    setSession(null)
    setCallback('')
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }

  // device 流程：自动轮询
  useEffect(() => {
    if (!session || session.flow !== 'device') return
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/collect/oauth/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, state: session.state }),
        })
        const d = await res.json().catch(() => ({}))
        if (d.done) {
          reset()
          if (d.error) setToast({ title: '授权失败', desc: d.error, ok: false })
          else {
            setToast({ title: '授权成功！', desc: d.message, ok: true })
            onDone()
          }
        }
      } catch {
        /* 忽略单次轮询错误，继续 */
      }
    }, 3000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, provider])

  async function start() {
    setBusy(true)
    setToast(null)
    try {
      const res = await fetch('/api/collect/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || '发起授权失败')
      setSession({ url: d.url, state: d.state, flow: d.flow, userCode: d.userCode })
    } catch (e) {
      setToast({ title: '发起授权失败', desc: (e as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  async function submitCallback() {
    if (!callback.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/collect/oauth/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, redirect_url: callback.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setToast({ title: '这个账号已贡献过', desc: '同一个账号只能贡献一次，换一个号试试。', ok: false })
        reset()
        return
      }
      if (!res.ok) throw new Error(d.error || '提交失败')
      setToast({ title: '授权成功！', desc: d.message, ok: true })
      reset()
      onDone()
    } catch (e) {
      setToast({ title: '提交失败', desc: (e as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  async function submitRt() {
    if (!rt.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/collect/rt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setToast({ title: '这个账号已贡献过', desc: '同一个账号只能贡献一次，换一个号试试。', ok: false })
        setRt('')
        return
      }
      if (!res.ok) throw new Error(d.error || '提交失败')
      setToast({ title: 'RT 提交成功！', desc: d.message, ok: true })
      setRt('')
      onDone()
    } catch (e) {
      setToast({ title: '提交失败', desc: (e as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--brand)]/25 bg-white/[0.03] p-6 shadow-[0_0_50px_-18px_rgba(16,163,127,0.45)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">
          <GiftIcon size={14} weight="fill" /> 验证通过按类型发积分
        </span>
      </div>
      <h2 className="mt-3 text-lg font-black text-white sm:text-2xl">贡献账号，赚积分兑好礼</h2>

      {/* provider 选择 */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setProvider(p.id)
              reset()
            }}
            className={`rounded-xl border px-2 py-2.5 text-center transition ${
              provider === p.id
                ? 'border-[var(--brand)]/50 bg-[var(--brand)]/10'
                : 'border-white/10 bg-white/[0.02] hover:bg-white/5'
            }`}
          >
            <div className={`text-sm font-semibold ${provider === p.id ? 'text-white' : 'text-neutral-300'}`}>
              {p.name}
            </div>
            <div className="mt-0.5 text-[10px] text-neutral-500">{p.sub}</div>
          </button>
        ))}
      </div>

      {session ? (
        session.flow === 'device' ? (
          // 设备码流程（Grok）
          <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/20 p-4">
            <a
              href={session.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 py-3 text-sm font-bold text-white transition hover:bg-[var(--brand-bright)]"
            >
              <ArrowSquareOutIcon size={16} weight="bold" />
              打开授权页并输入下方验证码
            </a>
            <div className="rounded-xl border border-white/10 bg-white/5 py-3 text-center">
              <div className="text-[11px] text-neutral-500">验证码</div>
              <div className="mono mt-1 text-2xl font-black tracking-widest text-[var(--brand-bright)]">
                {session.userCode}
              </div>
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-neutral-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-[var(--brand-bright)]" />
              授权后自动完成，请稍候…
            </div>
            <button
              onClick={reset}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-neutral-300 transition hover:bg-white/10"
            >
              取消
            </button>
          </div>
        ) : (
          // 跳转+粘贴流程（ChatGPT / Claude）
          <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/20 p-4">
            <a
              href={session.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 py-3 text-sm font-bold text-white transition hover:bg-[var(--brand-bright)]"
            >
              <ArrowSquareOutIcon size={16} weight="bold" />
              打开授权页
            </a>
            <div className="text-xs leading-relaxed text-neutral-400">
              授权后浏览器会跳到一个<span className="text-neutral-200">打不开的 localhost 链接</span>
              ，把地址栏那条链接<span className="text-neutral-200">整条复制</span>粘到下面：
            </div>
            <textarea
              value={callback}
              onChange={(e) => setCallback(e.target.value)}
              rows={2}
              placeholder="http://localhost:1455/auth/callback?code=...&state=..."
              className={inputCls}
            />
            <div className="flex gap-2">
              <button
                onClick={submitCallback}
                disabled={busy || !callback.trim()}
                className="flex-1 rounded-xl bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--brand-bright)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? '提交中…' : '提交'}
              </button>
              <button
                onClick={reset}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-neutral-300 transition hover:bg-white/10"
              >
                取消
              </button>
            </div>
          </div>
        )
      ) : (
        <button
          onClick={start}
          disabled={busy}
          className="group mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-[var(--brand)]/20 transition hover:-translate-y-0.5 hover:bg-[var(--brand-bright)] hover:shadow-xl hover:shadow-[var(--brand)]/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <>
              {provider === 'codex' && <OpenAIMark className="h-4 w-4 shrink-0" />}
              <span>授权 {PROVIDERS.find((p) => p.id === provider)!.name} 账号</span>
              <span className="shrink-0 transition group-hover:translate-x-0.5">→</span>
            </>
          )}
        </button>
      )}

      {/* RT 入口仅 ChatGPT */}
      {provider === 'codex' && !session && (
        <>
          <div className="my-3 flex items-center gap-3 text-[11px] text-neutral-600">
            <div className="h-px flex-1 bg-white/10" />
            或
            <div className="h-px flex-1 bg-white/10" />
          </div>
          <button
            onClick={() => setAdvanced((v) => !v)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-medium text-neutral-200 transition hover:border-white/25 hover:bg-white/10"
          >
            <KeyIcon size={16} weight="bold" className="text-neutral-400" />
            手动粘贴 Refresh Token
            <CaretRightIcon size={13} weight="bold" className={`text-neutral-500 transition ${advanced ? 'rotate-90' : ''}`} />
          </button>
          {advanced && (
            <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-black/20 p-4">
              <label className="block text-xs font-medium text-neutral-400">粘贴 OpenAI Refresh Token (RT)</label>
              <textarea value={rt} onChange={(e) => setRt(e.target.value)} rows={3} placeholder="eyJhbGciOi..." className={inputCls} />
              <button
                onClick={submitRt}
                disabled={busy || !rt.trim()}
                className="w-full rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                提交 RT
              </button>
            </div>
          )}
        </>
      )}

      {toast && (
        <div
          className={`mt-4 flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${
            toast.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          <span className="mt-0.5 font-black">{toast.ok ? '✓' : '✕'}</span>
          <div>
            <div className="font-semibold">{toast.title}</div>
            <div className="mt-0.5 opacity-80">{toast.desc}</div>
          </div>
        </div>
      )}
    </div>
  )
}
