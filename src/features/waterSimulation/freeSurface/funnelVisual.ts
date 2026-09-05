import * as THREE from 'three'
import type { FluidLayout } from './types'

/** Shared accessory for the flat and perspective views. Water is always particles. */
export function buildFunnelVisual(layout: FluidLayout): THREE.Group {
  const group = new THREE.Group()
  group.name = 'water-funnel'
  const { funnel: f, inletX: x } = layout
  const glass = new THREE.MeshBasicMaterial({ color: '#b5dce3', transparent: true, opacity: 0.055, depthWrite: false, side: THREE.DoubleSide })
  const collarGlass = new THREE.MeshBasicMaterial({ color: '#d3e6e9', transparent: true, opacity: 0.025, depthWrite: false, side: THREE.DoubleSide })
  const edge = new THREE.MeshBasicMaterial({ color: '#afc7ce' })
  const edgeSide = new THREE.MeshBasicMaterial({ color: '#78939e' })
  const highlight = new THREE.MeshBasicMaterial({ color: '#eef7f7', transparent: true, opacity: 0.86, depthWrite: false })
  const collarEdge = new THREE.MeshBasicMaterial({ color: '#a7bfc7', transparent: true, opacity: 0.35, depthWrite: false })

  const shape = (points: number[][]) => {
    const result = new THREE.Shape()
    points.forEach(([px, py], index) => index ? result.lineTo(px, -py) : result.moveTo(px, -py))
    result.closePath()
    return result
  }
  const pane = (points: number[][], material: THREE.Material, z: number) => {
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape(points)), material)
    mesh.position.z = z
    mesh.renderOrder = 3
    group.add(mesh)
    return mesh
  }
  const rail = (a: number[], b: number[], width: number, material: THREE.Material = edge, z = 0.08) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    const dx = -(b[1] - a[1]) / length * width * 0.5
    const dy = (b[0] - a[0]) / length * width * 0.5
    const outline = shape([
      [a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy],
      [b[0] - dx, b[1] - dy], [a[0] - dx, a[1] - dy],
    ])
    const geometry = new THREE.ExtrudeGeometry(outline, { depth: 0.085, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, steps: 1 })
    const mesh = new THREE.Mesh(geometry, material === edge ? [edge, edgeSide] : material)
    mesh.position.z = z
    mesh.renderOrder = 2
    group.add(mesh)
    return mesh
  }

  // The bowl stays almost clear; its continuous sloping rails cover the tiny
  // collision steps while leaving the real stream and filling level visible.
  pane([
    [x - f.halfWidth, f.mouthY], [x + f.halfWidth, f.mouthY],
    [x + f.neckHalfWidth, f.neckY], [x + f.neckHalfWidth, layout.topY],
    [x - f.neckHalfWidth, layout.topY], [x - f.neckHalfWidth, f.neckY],
  ], glass, 0.055)
  for (const side of [-1, 1]) {
    const mouth = [x + side * f.halfWidth, f.mouthY]
    const neck = [x + side * f.neckHalfWidth, f.neckY]
    rail(mouth, neck, 0.10)
    rail(neck, [neck[0], layout.topY + 0.01], 0.10)
    rail([mouth[0] - side * 0.022, mouth[1]], [neck[0] - side * 0.022, neck[1]], 0.016, highlight, 0.175)
  }
  const rimPoints = Array.from({ length: 49 }, (_, i) => {
    const angle = i / 48 * Math.PI * 2
    return new THREE.Vector3(x + Math.cos(angle) * (f.halfWidth + 0.018), -f.mouthY + Math.sin(angle) * 0.055, 0.16)
  })
  const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPoints), 48, 0.019, 6, false), edge)
  rim.renderOrder = 3
  group.add(rim)

  // This lightly outlined splash collar is physically present: if a blocked
  // maze fills the bowl, pressure reaches the source and admission stops.
  pane([
    [x - f.halfWidth, f.collarTopY], [x + f.halfWidth, f.collarTopY],
    [x + f.halfWidth, f.mouthY], [x - f.halfWidth, f.mouthY],
  ], collarGlass, 0.04)
  for (const side of [-1, 1]) {
    rail([x + side * f.halfWidth, f.collarTopY], [x + side * f.halfWidth, f.mouthY], 0.022, collarEdge, 0.06)
    rail([x + side * f.halfWidth, f.collarTopY], [x + side * 0.5, f.collarTopY], 0.022, collarEdge, 0.06)
  }

  // The .90-cell outlet fits all six physical emission lanes, including radius.
  // Its lip sits above inletY; no independent decorative water jet is drawn.
  const nozzleTop = f.collarTopY - 0.25
  const nozzleBottom = f.sourceY - 0.10
  const nozzleShape = shape([
    [x - 0.53, nozzleTop], [x + 0.53, nozzleTop],
    [x + 0.53, nozzleBottom - 0.06], [x + 0.47, nozzleBottom],
    [x - 0.47, nozzleBottom], [x - 0.53, nozzleBottom - 0.06],
  ])
  const nozzle = new THREE.Mesh(new THREE.ExtrudeGeometry(nozzleShape, {
    depth: 0.14, bevelEnabled: true, bevelSize: 0.016, bevelThickness: 0.016, bevelSegments: 3, steps: 1,
  }), [new THREE.MeshBasicMaterial({ color: '#9fadb0' }), new THREE.MeshBasicMaterial({ color: '#71848b' })])
  nozzle.position.z = 0.075
  nozzle.renderOrder = 3
  group.add(nozzle)
  rail([x - 0.44, nozzleTop + 0.09], [x + 0.44, nozzleTop + 0.09], 0.022, highlight, 0.225)
  const opening = pane([
    [x - 0.45, nozzleBottom - 0.035], [x + 0.45, nozzleBottom - 0.035],
    [x + 0.45, nozzleBottom + 0.014], [x - 0.45, nozzleBottom + 0.014],
  ], new THREE.MeshBasicMaterial({ color: '#3c5d69' }), 0.24)
  opening.renderOrder = 4
  const supplyGlint = pane([
    [x - 0.43, nozzleBottom - 0.005], [x + 0.43, nozzleBottom - 0.005],
    [x + 0.43, nozzleBottom + 0.012], [x - 0.43, nozzleBottom + 0.012],
  ], new THREE.MeshBasicMaterial({ color: '#77bed0', transparent: true, opacity: 0.68, depthWrite: false }), 0.245)
  supplyGlint.name = 'supply-glint'
  supplyGlint.renderOrder = 5
  return group
}
