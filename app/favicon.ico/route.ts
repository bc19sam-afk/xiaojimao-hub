const FAVICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="小鸡毛公益宇宙">
  <rect width="64" height="64" rx="15" fill="#0d0d0d"/>
  <circle cx="32" cy="32" r="19" fill="none" stroke="#10a37f" stroke-width="4"/>
  <path d="M18 36c8-14 20-20 31-17-5 1-9 4-12 8 5-1 9 0 12 2-8 0-15 4-20 12-3 4-8 5-11 2 3-1 5-3 6-6-2 1-4 1-6-1z" fill="#19c99a"/>
  <circle cx="47" cy="17" r="4" fill="#f5f5f5"/>
</svg>`.trim()

export const dynamic = 'force-static'

export function GET() {
  return new Response(FAVICON, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
}
