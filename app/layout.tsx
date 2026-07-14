import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OpenAI Plus 账号收集系统 · 小鸡毛の公益宇宙',
  description: '贡献 ChatGPT Plus 账号，验证通过即入池，兑换公益站额度',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
        className="min-h-screen font-sans antialiased text-neutral-100"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  )
}
