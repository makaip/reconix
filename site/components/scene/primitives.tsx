'use client'

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import { slabGeometry, matte } from './geometry'
import { asset } from '@/lib/utils'

// Parts with an id register here so the rig can lift them toward the camera when their beat
// is on screen. `base` is the resting z; `lift` is how far the part travels when fully focused.
export interface FocusEntry {
  obj: THREE.Object3D
  base: number
  lift: number
  weight: number
}
export type FocusRegistry = Map<string, FocusEntry>
export const FocusContext = createContext<FocusRegistry | null>(null)

const FONT = asset('/fonts/hanken-grotesk-500.woff')

interface SlabProps {
  x?: number
  y?: number
  z?: number
  rz?: number
  w: number
  h: number
  d?: number
  r?: number
  color: string
  id?: string
  lift?: number
  children?: ReactNode
}

// A raised rounded-rect slab. Children are positioned relative to its center, on its front face.
export function Slab({ x = 0, y = 0, z = 0, rz = 0, w, h, d = 0.03, r = 0.04, color, id, lift = 0.16, children }: SlabProps) {
  const group = useRef<THREE.Group>(null)
  const registry = useContext(FocusContext)

  useLayoutEffect(() => {
    if (!id || !registry || !group.current) return
    registry.set(id, { obj: group.current, base: z, lift, weight: 0 })
    return () => {
      registry.delete(id)
    }
  }, [id, registry, z, lift])

  return (
    <group ref={group} position={[x, y, z]} rotation={[0, 0, rz]}>
      <mesh geometry={slabGeometry(w, h, d, r)} material={matte(color)} castShadow receiveShadow />
      {children && <group position={[0, 0, d]}>{children}</group>}
    </group>
  )
}

// A round button or status dot.
export function Dot({ x = 0, y = 0, size, color, d = 0.02 }: { x?: number; y?: number; size: number; color: string; d?: number }) {
  return <Slab x={x} y={y} w={size} h={size} d={d} r={size / 2} color={color} />
}

// A skeleton text line, anchored at its left edge so rows of different lengths align.
export function Line({ x, y, w, h = 0.06, color }: { x: number; y: number; w: number; h?: number; color: string }) {
  return <Slab x={x + w / 2} y={y} w={w} h={h} d={0.008} r={h / 2} color={color} />
}

interface LabelProps {
  x: number
  y: number
  size?: number
  color: string
  children: string
  anchor?: 'left' | 'center' | 'right'
  maxWidth?: number
}

// Real text, lit like everything else so lifted parts shade it correctly.
export function Label({ x, y, size = 0.1, color, children, anchor = 'left', maxWidth }: LabelProps) {
  return (
    <Text
      position={[x, y, 0.002]}
      fontSize={size}
      font={FONT}
      anchorX={anchor}
      anchorY="middle"
      maxWidth={maxWidth}
      lineHeight={1.3}
      letterSpacing={-0.01}
      receiveShadow
    >
      {children}
      <meshStandardMaterial color={color} roughness={0.9} metalness={0} />
    </Text>
  )
}

// Small stroke icons built from thin bars, so toolbar buttons read as real controls.
export function Chevron({ dir, color }: { dir: 'left' | 'right'; color: string }) {
  const k = dir === 'left' ? -1 : 1
  return (
    <group position={[-0.012 * k, 0, 0]}>
      <Slab y={0.024} rz={k * -0.785} w={0.075} h={0.022} d={0.006} r={0.011} color={color} />
      <Slab y={-0.024} rz={k * 0.785} w={0.075} h={0.022} d={0.006} r={0.011} color={color} />
    </group>
  )
}
