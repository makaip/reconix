'use client'

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { BEATS } from '@/lib/narrative'
import { scroll, prefersReducedMotion } from './scroll'
import { FocusContext, type FocusRegistry } from './primitives'
import { pickPalette } from './palette'
import Model from './Model'

RectAreaLightUniformsLib.init()

// Light comes from the viewer's top left. The area light gives the broad, soft falloff across
// the surfaces; the directional light at the same angle only exists to cast soft shadows.
const KEY_POS = new THREE.Vector3(-7, 8, 9)

const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

// Scroll -> which two beats we're between, and how far. Each beat holds still for a moment
// (the plateau) so the copy can be read before the camera moves on.
function blend(progress: number) {
  const n = BEATS.length
  const s = Math.min(n - 1, Math.max(0, progress * (n - 1)))
  const i = Math.min(n - 2, Math.floor(s))
  const raw = s - i
  const hold = 0.18
  const t = smootherstep(Math.min(1, Math.max(0, (raw - hold) / (1 - hold * 2))))
  return { a: BEATS[i], b: BEATS[i + 1], t }
}

// On wide screens the copy takes one side (per beat) and the model is drawn shifted to the
// other. On narrow screens the copy sits at the bottom, so the model shifts up and pulls back.
// Must match the `wide` screen in tailwind.config.ts.
const isWide = (width: number, height: number) => width / height >= 0.9 && width >= 768

function layoutFor(width: number, height: number) {
  if (!isWide(width, height)) return { wide: false, shiftX: 0, shiftY: 0.2, distance: 2.1 }
  if (width / height < 1.35) return { wide: true, shiftX: 0.16, shiftY: 0, distance: 1.45 }
  return { wide: true, shiftX: 0.2, shiftY: 0, distance: 1 }
}

export default function Rig() {
  const { camera, size } = useThree()
  const registry = useMemo<FocusRegistry>(() => new Map(), [])
  const palette = useMemo(() => pickPalette(), [])
  const reduced = useMemo(() => prefersReducedMotion(), [])
  const area = useRef<THREE.RectAreaLight>(null)
  const sun = useRef<THREE.DirectionalLight>(null)
  const look = useRef(new THREE.Vector3(...BEATS[0].target))
  const pointer = useRef({ x: 0, y: 0 })
  const tmpPos = useMemo(() => new THREE.Vector3(), [])
  const tmpLook = useMemo(() => new THREE.Vector3(), [])
  const tmpB = useMemo(() => new THREE.Vector3(), [])
  const dirA = useMemo(() => new THREE.Vector3(), [])
  const dirB = useMemo(() => new THREE.Vector3(), [])
  const first = useRef(true)

  useLayoutEffect(() => {
    area.current?.lookAt(0, 0, 0)
    if (sun.current) {
      sun.current.target.position.set(0, 0, 0)
      sun.current.target.updateMatrixWorld()
    }
  }, [])

  // The canvas ignores pointer events (links sit above it), so track the pointer on window.
  useEffect(() => {
    if (reduced) return
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [reduced])

  useFrame((_, delta) => {
    const cam = camera as THREE.PerspectiveCamera
    const { a, b, t } = blend(scroll.progress)
    const layout = layoutFor(size.width, size.height)

    // Orbit rather than slide: interpolate the camera's direction and distance from its target
    // separately. A straight line between two angled close-ups passes right in front of the
    // window and fills the screen. Mid-move the camera also eases back a little, more when the
    // copy switches sides, so the model never sweeps under the text at full size.
    tmpLook.set(...a.target).lerp(tmpB.set(...b.target), t)
    dirA.set(...a.camera).sub(tmpB.set(...a.target))
    dirB.set(...b.camera).sub(tmpB.set(...b.target))
    const dist = dirA.length() + (dirB.length() - dirA.length()) * t
    dirA.normalize().lerp(dirB.normalize(), t).normalize()
    const pullback = 1 + (a.side === b.side ? 0.18 : 0.75) * Math.sin(Math.PI * t)
    tmpPos.copy(dirA).multiplyScalar(dist * pullback * layout.distance).add(tmpLook)
    if (!reduced) {
      tmpPos.x += pointer.current.x * 0.25
      tmpPos.y -= pointer.current.y * 0.15
    }

    // Ease toward the target so native scrolling still gives a smooth camera.
    const k = first.current || reduced ? 1 : 1 - Math.exp(-delta * 5)
    first.current = false
    cam.position.lerp(tmpPos, k)
    look.current.lerp(tmpLook, k)
    cam.lookAt(look.current)
    // Copy on the left pushes the model right (+1); copy on the right pushes it left (-1).
    const sideA = a.side === 'left' ? 1 : -1
    const sideB = b.side === 'left' ? 1 : -1
    const side = layout.wide ? sideA + (sideB - sideA) * t : 0
    cam.setViewOffset(
      size.width,
      size.height,
      -layout.shiftX * side * size.width,
      layout.shiftY * size.height,
      size.width,
      size.height
    )

    // Lift focused parts toward the camera; their shadows grow, which is what sells the depth.
    registry.forEach((entry, id) => {
      const target = (a.focus.includes(id) ? 1 - t : 0) + (b.focus.includes(id) ? t : 0)
      entry.weight += (target - entry.weight) * k
      entry.obj.position.z = entry.base + entry.lift * entry.weight
    })
  })

  return (
    <FocusContext.Provider value={registry}>
      <color attach="background" args={['#0b0b0c']} />
      <hemisphereLight args={['#ffffff', '#1c1c20', 0.26]} />
      <rectAreaLight
        ref={area}
        position={KEY_POS.toArray()}
        width={8}
        height={8}
        intensity={7}
        color="#ffffff"
      />
      <directionalLight
        ref={sun}
        position={KEY_POS.toArray()}
        intensity={1.25}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={9}
        shadow-blurSamples={20}
        shadow-bias={-0.0002}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
        shadow-camera-near={1}
        shadow-camera-far={40}
      />

      <Model p={palette} />
    </FocusContext.Provider>
  )
}
