'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// WebGL 流动星云：fragment shader 用 fbm 分形噪声生成真实湍流质感，
// 品牌绿墨黑色调，随时间缓慢演化。参考通行的 GLSL fbm nebula 做法。
// prefers-reduced-motion 下渲染一帧静态。
const FRAG = /* glsl */ `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;

// hash + value noise
float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fractal brownian motion
float fbm(vec2 p){
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for(int i = 0; i < 6; i++){
    v += amp * noise(p);
    p = rot * p * 2.0;
    amp *= 0.5;
  }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;

  float t = uTime * 0.02;

  // 域扭曲：让星云有翻涌的湍流感
  vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)), fbm(p * 1.6 + vec2(5.2, -t)));
  vec2 r = vec2(fbm(p * 1.6 + 3.0 * q + vec2(1.7, 9.2) + t * 0.5),
                fbm(p * 1.6 + 3.0 * q + vec2(8.3, 2.8) - t * 0.5));
  float f = fbm(p * 1.6 + 3.5 * r);

  // 品牌绿墨黑调色
  vec3 deep = vec3(0.02, 0.05, 0.045);          // 深空底
  vec3 brand = vec3(0.063, 0.639, 0.498);        // #10a37f
  vec3 bright = vec3(0.098, 0.788, 0.604);       // #19c99a

  vec3 col = mix(deep, brand, smoothstep(0.35, 0.85, f));
  col = mix(col, bright, smoothstep(0.7, 1.0, f * f));

  // 压暗为主：深空底色占主导，星云只在高密度处透出
  col *= 0.32;

  // 强暗角：四周沉入黑暗，中心留一点云气
  float vignette = smoothstep(1.25, 0.15, length(p));
  col *= 0.25 + 0.85 * vignette;
  col += bright * pow(max(0.0, r.x * r.y), 2.5) * 0.35; // 零星亮点

  // 整体再压一档，让文字浮出来
  col = mix(deep * 0.4, col, 0.78);

  gl_FragColor = vec4(col, 1.0);
}
`

const VERT = /* glsl */ `
void main(){
  gl_Position = vec4(position, 1.0);
}
`

export default function NebulaBackground() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = ref.current
    if (!mount) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'

    const scene = new THREE.Scene()
    const camera = new THREE.Camera()
    const uniforms = {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
    }
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    scene.add(quad)

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      renderer.setSize(w, h, false)
      uniforms.uResolution.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio())
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    const start = performance.now()
    const loop = () => {
      uniforms.uTime.value = (performance.now() - start) / 1000
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    if (reduce) {
      uniforms.uTime.value = 12
      renderer.render(scene, camera)
    } else {
      raf = requestAnimationFrame(loop)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      material.dispose()
      quad.geometry.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
}
