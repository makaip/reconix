'use client'

// Shared scroll progress (0..1). Lenis (or a native fallback) writes it; the R3F useFrame loop
// reads it every frame. A plain module ref avoids re-rendering React on every scroll tick.
export const scroll = { progress: 0 }

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
