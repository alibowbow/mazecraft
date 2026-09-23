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

/** Soft dappled shade from branches outside the frame (1 = full sun). */
export function createLeafShadowTexture(size = 512): THREE.DataTexture {
  const shade = new Float32Array(size * size)
  let seed = 7
  const random = () => fract(Math.sin(seed++ * 91.345) * 47453.5453)
  // Three drooping branches enter from one corner; leaves hang along them.
  for (let branch = 0; branch < 4; branch++) {
    let x = -0.05 + random() * 0.25, y = 0.55 + random() * 0.5
    let angle = -0.35 - random() * 0.7
    const length = 0.75 + random() * 0.35
    for (let t = 0; t < length; t += 0.012) {
      x += Math.cos(angle) * 0.012; y += Math.sin(angle) * 0.012
      angle += (random() - 0.5) * 0.12 - 0.004
      // Stem: a thin, faint line.
      stamp(shade, size, x, y, 0.004, 0.004, 0, 0.35)
      if (random() < 0.62) {
        const side = random() < 0.5 ? -1 : 1
        const leafAngle = angle + side * (0.6 + random() * 0.6)
        const leafLength = 0.028 + random() * 0.026
        const cx = x + Math.cos(leafAngle) * leafLength, cy = y + Math.sin(leafAngle) * leafLength
        stamp(shade, size, cx, cy, leafLength, leafLength * 0.32, leafAngle, 0.85)
      }
    }
  }
  const data = new Uint8Array(size * size * 4)
  // A light blur imitates the penumbra of a distant, finite sun.
  const blurred = blur(blur(shade, size), size)
  for (let i = 0; i < size * size; i++) {
    const light = 1 - Math.min(1, blurred[i]) * 0.72
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(light * 255)
    data[i * 4 + 3] = 255
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  texture.name = 'garden-leaf-shade'
  return texture
}

function stamp(target: Float32Array, size: number, cx: number, cy: number, rx: number, ry: number, angle: number, strength: number) {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const reach = Math.max(rx, ry) * 1.2
  const x0 = Math.max(0, Math.floor((cx - reach) * size)), x1 = Math.min(size - 1, Math.ceil((cx + reach) * size))
  const y0 = Math.max(0, Math.floor((cy - reach) * size)), y1 = Math.min(size - 1, Math.ceil((cy + reach) * size))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = (x + 0.5) / size - cx, dy = (y + 0.5) / size - cy
    const u = (dx * cos + dy * sin) / rx, v = (-dx * sin + dy * cos) / ry
    const d = u * u + v * v
    if (d < 1) target[y * size + x] = Math.max(target[y * size + x], strength * Math.min(1, (1 - d) * 3))
  }
}

function blur(source: Float32Array, size: number): Float32Array {
  const horizontal = new Float32Array(source.length), result = new Float32Array(source.length)
  const weights = [0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = source[y * size + x] * weights[0]
    for (let k = 1; k < 5; k++) sum += (source[y * size + Math.max(0, x - k)] + source[y * size + Math.min(size - 1, x + k)]) * weights[k]
    horizontal[y * size + x] = sum
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = horizontal[y * size + x] * weights[0]
    for (let k = 1; k < 5; k++) sum += (horizontal[Math.max(0, y - k) * size + x] + horizontal[Math.min(size - 1, y + k) * size + x]) * weights[k]
    result[y * size + x] = sum
  }
  return result
}

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
