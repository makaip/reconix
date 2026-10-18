'use client'

import dynamic from 'next/dynamic'
import ScrollProvider from '@/components/scene/ScrollProvider'
import Nav from '@/components/sections/Nav'
import { Intro, Step, Outro } from '@/components/sections/Story'
import { BEATS } from '@/lib/narrative'

// WebGL is client-only; loading it lazily lets the copy paint first.
const Scene = dynamic(() => import('@/components/scene/Scene'), { ssr: false })

export default function Home() {
  const first = BEATS[0]
  const last = BEATS[BEATS.length - 1]
  return (
    <ScrollProvider>
      <Scene />
      <Nav />
      <main className="content-layer">
        <Intro beat={first} />
        {BEATS.slice(1, -1).map((beat) => (
          <Step key={beat.id} beat={beat} />
        ))}
        <Outro beat={last} />
      </main>
    </ScrollProvider>
  )
}
