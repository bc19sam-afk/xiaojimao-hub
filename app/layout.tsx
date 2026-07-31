import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '小鸡毛账号收集系统 · 公益宇宙',
  description: '贡献 ChatGPT、Claude 与 Grok 账号，验证入池后按用量赚积分并兑换公益站权益',
  icons: {
    icon: [{ url: '/favicon.ico', type: 'image/svg+xml' }],
    shortcut: '/favicon.ico',
  },
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
