import * as THREE from 'three'

export interface SkyOptions {
  /** World-space direction towards the sun (z up). */
  sun: readonly [number, number, number]
  /** Linear sun tint. */
  sunColor: THREE.Color
  /** Relative warmth of the horizon, 0 cool → 1 golden. */
  warmth: number
}

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * A linear HDR courtyard: blue zenith, bright hazy horizon, warm sand below
 * and a soft sun glow, with a band of dark foliage for water reflections to
 * pick up. Generated in memory; no image download.
 */
export function createGardenSky(renderer: THREE.WebGLRenderer, options: SkyOptions): THREE.WebGLRenderTarget {
  const width = 512, height = 256, pixels = new Float32Array(width * height * 4)
  const sun = new THREE.Vector3(...options.sun).normalize()
  const direction = new THREE.Vector3()
  // Radiances are balanced against a ~4 lux-unit sun so that shade keeps
  // roughly 40 % of full sunlight, as in an open courtyard.
  const zenith = new THREE.Color(0.3, 0.46, 0.78).multiplyScalar(0.62)
  const horizon = new THREE.Color(1.0, 0.96, 0.9).lerp(new THREE.Color(1.0, 0.86, 0.68), options.warmth).multiplyScalar(1.05)
  const ground = new THREE.Color(0.78, 0.68, 0.55).multiplyScalar(0.34)
  const foliage = new THREE.Color(0.2, 0.26, 0.16).multiplyScalar(0.25)
  const color = new THREE.Color()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI
    const longitude = ((x + 0.5) / width - 0.5) * Math.PI * 2
    // Three's equirect lookup puts its "up" in texel latitude; the world is z-up,
    // so evaluate the radiance for the world direction that samples this texel.
    direction.set(Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude))
    const up = direction.z
    const azimuth = Math.atan2(direction.y, direction.x)
    if (up >= 0) {
      color.copy(horizon).lerp(zenith, smooth(0, 0.75, up) ** 0.8)
      // Irregular tree line near the horizon: dark, low-frequency silhouettes.
      const canopy = 0.07 + 0.06 * Math.sin(azimuth * 3.0 + 1.3) + 0.04 * Math.sin(azimuth * 7.0 + 0.4) + 0.02 * Math.sin(azimuth * 17.0)
      const trees = (1 - smooth(canopy - 0.03, canopy + 0.02, up)) * smooth(-0.5, 0.2, Math.sin(azimuth * 1.7 + 2.1))
      color.lerp(foliage, trees * 0.8)
    } else {
      color.copy(ground).lerp(horizon, (1 - smooth(-0.25, 0, up)) * 0.35)
    }
    // Bright clouds / sunlit courtyard walls: broad soft panels that paint
    // long highlights on glossy glaze without adding much diffuse light.
    if (up > -0.05) {
      const sunAzimuth = Math.atan2(sun.y, sun.x)
      for (const [offset, elevation, spread, radiance] of [[0.55, 0.32, 0.35, 2.6], [-0.9, 0.22, 0.3, 1.9], [Math.PI, 0.18, 0.5, 1.4]] as const) {
        let da = azimuth - sunAzimuth - offset
        da = Math.atan2(Math.sin(da), Math.cos(da))
        const panel = Math.exp(-Math.pow(da / spread, 4) - Math.pow((up - elevation) / 0.12, 4))
        color.r += panel * radiance; color.g += panel * radiance * 0.98; color.b += panel * radiance * 0.95
      }
    }
    const toSun = Math.max(0, direction.dot(sun))
    const glow = Math.pow(toSun, 24) * 0.35 + Math.pow(toSun, 400) * 12 + Math.pow(toSun, 3000) * 60
    const index = (y * width + x) * 4
    pixels[index] = color.r + options.sunColor.r * glow
    pixels[index + 1] = color.g + options.sunColor.g * glow
    pixels[index + 2] = color.b + options.sunColor.b * glow
    pixels[index + 3] = 1
  }
  const hdr = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType)
  hdr.colorSpace = THREE.LinearSRGBColorSpace
  hdr.mapping = THREE.EquirectangularReflectionMapping
  hdr.minFilter = hdr.magFilter = THREE.LinearFilter
  hdr.needsUpdate = true
  const generator = new THREE.PMREMGenerator(renderer)
  const environment = generator.fromEquirectangular(hdr)
  generator.dispose(); hdr.dispose()
  environment.texture.name = 'garden-courtyard-sky'
  return environment
}

function fract(value: number) { return value - Math.floor(value) }

/** Seamless ripple normal map from a sum of periodic wave trains. */
export function createRippleNormals(seed: number, size = 256, waves = 14, sharpness = 4.2): THREE.DataTexture {
  const height = new Float32Array(size * size)
  let state = seed
  const random = () => fract(Math.sin(state++ * 127.1 + seed * 31.7) * 43758.5453)
  const trains = Array.from({ length: waves }, () => {
    let kx = Math.round(random() * 14) - 7, ky = Math.round(random() * 14) - 7
    if (!kx && !ky) kx = 3
    return { kx, ky, phase: random() * Math.PI * 2, amplitude: (0.6 + random() * 0.4) / Math.max(2, Math.hypot(kx, ky)) }
  })
  const tau = Math.PI * 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size
    const wu = u + Math.sin(v * tau + seed) * 0.035, wv = v + Math.sin(u * tau * 2 + seed * 0.7) * 0.04
    let value = 0
    for (const wave of trains) {
      // Sharpened crests: narrow bright ridges and broad troughs, like real ripples.
      const s = Math.sin((wu * wave.kx + wv * wave.ky) * tau + wave.phase)
      value += (1 - Math.pow(1 - (s * 0.5 + 0.5), 1.6)) * wave.amplitude
    }
    height[y * size + x] = value
  }
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (height[y * size + (x + 1) % size] - height[y * size + (x + size - 1) % size]) * sharpness
    const dy = (height[((y + 1) % size) * size + x] - height[((y + size - 1) % size) * size + x]) * sharpness
    const length = Math.hypot(dx, dy, 1), index = (y * size + x) * 4
    data[index] = Math.round((0.5 - dx / length * 0.5) * 255)
    data[index + 1] = Math.round((0.5 - dy / length * 0.5) * 255)
    data[index + 2] = Math.round((0.5 + 0.5 / length) * 255)
    // Alpha: a tileable foam/streak noise sharing the same period.
    const n = height[y * size + x]
    data[index + 3] = Math.round(Math.min(1, Math.max(0, n * 0.9 + 0.35)) * 255)
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true
  texture.name = `garden-ripples-${seed}`
  return texture
}
