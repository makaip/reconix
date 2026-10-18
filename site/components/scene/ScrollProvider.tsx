'use client'

import { useEffect } from 'react'
import { scroll } from './scroll'

// Native scrolling only. This just mirrors document scroll into `scroll.progress` for the rig,
// which does its own easing so the camera stays smooth.
export default function ScrollProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      scroll.progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return <>{children}</>
}
