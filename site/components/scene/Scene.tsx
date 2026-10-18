'use client'

import { Canvas } from '@react-three/fiber'
import { Suspense } from 'react'
import * as THREE from 'three'
import Rig from './Rig'

// Persistent full-viewport canvas fixed behind the page. It ignores pointer events
// (see .scene-layer) so the links above it stay clickable.
export default function Scene() {
  return (
    <div className="scene-layer" aria-hidden>
      <Canvas
        // Variance shadow maps blur cleanly; PCSS left a dotted stipple along thin edges.
        shadows="variance"
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [7.5, 4.2, 19], fov: 30, near: 0.1, far: 100 }}
        onCreated={({ gl }) => {
          // Neutral keeps the UI colors close to their hex values; ACES shifts them.
          gl.toneMapping = THREE.NeutralToneMapping
        }}
      >
        <Suspense fallback={null}>
          <Rig />
        </Suspense>
      </Canvas>
    </div>
  )
}
