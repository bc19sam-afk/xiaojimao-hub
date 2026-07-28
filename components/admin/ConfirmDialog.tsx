'use client'

import { useEffect, useId, useRef, useState } from 'react'

export interface ConfirmDialogRequest {
  title: string
  target: string
  consequence: string
  confirmLabel: string
}

export default function ConfirmDialog({
  request,
  onClose,
  onConfirm,
  fallbackFocus,
}: {
  request: ConfirmDialogRequest
  onClose: () => void
  onConfirm: () => Promise<void>
  fallbackFocus?: () => HTMLElement | null
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const inFlightRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    cancelRef.current?.focus()

    return () => {
      if (dialog?.open) dialog.close()
      const origin = returnFocusRef.current
      const target = origin?.isConnected ? origin : fallbackFocus?.()
      if (target?.isConnected) target.focus()
    }
  }, [fallbackFocus])

  async function confirm() {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (e) {
      setError((e as Error).message || '操作失败，请重试')
      inFlightRef.current = false
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-white/15 bg-neutral-950 p-0 text-neutral-200 shadow-2xl backdrop:bg-black/70"
    >
      <div className="p-5 sm:p-6">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/10 text-lg font-black text-rose-300" aria-hidden="true">
          !
        </div>
        <h2 id={titleId} className="text-lg font-bold text-white">{request.title}</h2>
        <div id={descriptionId} className="mt-3 space-y-2 text-sm leading-relaxed text-neutral-400">
          <p>
            操作目标：<span className="break-all font-medium text-neutral-100">{request.target}</span>
          </p>
          <p>{request.consequence}</p>
        </div>

        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-neutral-200 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="confirm-action-button"
            onClick={confirm}
            disabled={busy}
            className="rounded-xl border border-rose-400/30 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? '处理中…' : request.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
