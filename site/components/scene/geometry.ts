import * as THREE from 'three'

// Rounded-rectangle slab: rounded corners in the XY plane, with only a small chamfer on the
// edges that meet the front and back faces (a RoundedBox rounds those heavily, which reads as
// soft plastic). Back face sits at z=0, front face at z=depth. Cached so repeated sizes share
// one geometry.
const cache = new Map<string, THREE.BufferGeometry>()

export function slabGeometry(w: number, h: number, depth: number, radius: number) {
  const key = `${w}|${h}|${depth}|${radius}`
  const hit = cache.get(key)
  if (hit) return hit

  const bevel = Math.min(0.01, depth * 0.25, Math.min(w, h) * 0.1)
  const iw = w - bevel * 2
  const ih = h - bevel * 2
  const r = Math.max(0, Math.min(radius - bevel, iw / 2, ih / 2))
  const x = -iw / 2
  const y = -ih / 2

  const shape = new THREE.Shape()
  shape.moveTo(x + r, y)
  shape.lineTo(x + iw - r, y)
  shape.quadraticCurveTo(x + iw, y, x + iw, y + r)
  shape.lineTo(x + iw, y + ih - r)
  shape.quadraticCurveTo(x + iw, y + ih, x + iw - r, y + ih)
  shape.lineTo(x + r, y + ih)
  shape.quadraticCurveTo(x, y + ih, x, y + ih - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0001, depth - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 10
  })
  geo.translate(0, 0, bevel)
  cache.set(key, geo)
  return geo
}

// Matte materials shared per color.
const mats = new Map<string, THREE.MeshStandardMaterial>()
export function matte(color: string) {
  const hit = mats.get(color)
  if (hit) return hit
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 })
  mats.set(color, m)
  return m
}
