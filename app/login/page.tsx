import { OpenAIMark } from '@/components/OpenAIMark'
import StarField from '@/components/StarField'
import NebulaBackground from '@/components/NebulaBackground'
import { env } from '@/lib/env'

const ERRORS: Record<string, string> = {
  state: '登录校验失败（state 不匹配），请重试。',
  trust: '你的 Linux.do 信任等级不足，暂时无法参与。',
  oauth: 'Linux.do 授权失败，请重试。',
  config: '尚未配置 Linux.do OAuth（管理员请填写 LINUXDO_CLIENT_ID）。',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const msg = error ? ERRORS[error] ?? '登录失败，请重试。' : null

  return (
    <main className="bg-ink relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-4">
      <NebulaBackground />
      <StarField />
      <div className="bg-grid absolute inset-0" />

      <div className="relative w-full max-w-sm">
        {/* 内容辉光托底：把内容簇从星空里托出来 */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -z-0 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(16,163,127,0.12),transparent_62%)]" />

        {/* Hero: OpenAI 标志 + 呼吸辉光 */}
        <div className="relative mb-9 flex flex-col items-center text-center">
          <div className="relative mb-7">
            <div className="animate-breathe absolute -inset-4 rounded-full bg-[var(--brand)] blur-3xl" />
            <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl border border-white/10 bg-[var(--ink-soft)] shadow-2xl">
              <OpenAIMark className="h-12 w-12 text-white" />
            </div>
          </div>

          <div className="mono mb-4 flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-[var(--brand-bright)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-bright)]" />
            小鸡毛の公益宇宙
          </div>

          <h1 className="text-[32px] font-black leading-[1.15] tracking-tight text-white sm:text-4xl">
            OpenAI Plus<br />账号收集系统
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-neutral-400">
            贡献一颗 ChatGPT Plus 星辰，汇入公益星系，
            <br className="hidden sm:block" />
            验证通过即入池并发放额度兑换码
          </p>
        </div>

        {/* 卡片 */}
        <div className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm">
          {msg && (
            <div className="mb-5 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {msg}
            </div>
          )}

          <a
            href="/api/auth/linuxdo/start"
            className="group flex w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 py-4 text-[15px] font-semibold text-neutral-900 shadow-lg transition duration-150 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-[var(--brand)]/25"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-sm font-black text-white">
              L
            </span>
            使用 Linux.do 账号登录
            <span className="transition duration-150 group-hover:translate-x-0.5">→</span>
          </a>

          {env.mock && (
            <a
              href="/api/auth/dev-login"
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--brand)]/40 bg-[var(--brand)]/5 px-4 py-3 text-sm font-medium text-[var(--brand-bright)] transition hover:bg-[var(--brand)]/10"
            >
              预览进入（模拟模式，免登录）
            </a>
          )}

          <div className="mono mt-4 text-center text-[11px] text-neutral-600">
            仅收 ChatGPT Plus · 凭证由网关加密托管
          </div>
        </div>
      </div>
    </main>
  )
}
