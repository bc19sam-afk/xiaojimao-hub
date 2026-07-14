'use client'

import { useEffect, useRef } from 'react'

// 「小鸡毛の公益宇宙」星空背景：贡献的账号如星辰汇入公益星系。
// canvas 绘制，不进 React 渲染；prefers-reduced-motion 下退化为静态星点。
export default function StarField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    let w = 0
    let h = 0
    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const count = Math.min(140, Math.floor((w * h) / 9000))
    const stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.4 + 0.3,
      // 大多冷白，少数品牌绿
      green: Math.random() < 0.22,
      tw: Math.random() * Math.PI * 2, // 闪烁相位
      tws: Math.random() * 0.015 + 0.004,
      vy: Math.random() * 0.06 + 0.02, // 缓慢上浮，寓意汇入
    }))

    let raf = 0
    const draw = (drift: number) => {
      ctx.clearRect(0, 0, w, h)
      for (const s of stars) {
        const a = reduce ? 0.7 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(s.tw + drift))
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = s.green
          ? `rgba(25, 201, 154, ${a})`
          : `rgba(226, 232, 240, ${a * 0.9})`
        ctx.shadowBlur = s.green ? 6 : 0
        ctx.shadowColor = 'rgba(25, 201, 154, 0.8)'
        ctx.fill()
      }
      ctx.shadowBlur = 0
    }

    if (reduce) {
      draw(0)
    } else {
      let t = 0
      const loop = () => {
        t += 1
        for (const s of stars) {
          s.tw += s.tws
          s.y -= s.vy
          if (s.y < -2) {
            s.y = h + 2
            s.x = Math.random() * w
          }
        }
        draw(t * 0.02)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }

    const onResize = () => resize()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    />
  )
}
