import { expect, test } from '@playwright/test'
import { WATER_WALL_VISIBILITY } from '../src/features/waterSimulation/freeSurface/surfaceField'

test('free-surface GPU field rejects water across thin walls while keeping passages open', async ({ page }) => {
  await page.goto('/')
  const results = await page.evaluate((visibility) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const gl = canvas.getContext('webgl2')
    if (!gl) throw new Error('WebGL2 is required for water rendering')

    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed')
      }
      return shader
    }
    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`)
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      #define texture2D texture
      uniform vec4 path;
      out vec4 color;
      ${visibility}
      void main() {
        color = vec4(clearSegment(path.xy, path.zw), wallAt(path.xy), wallAt(path.zw), 1.0);
      }`)
    const program = gl.createProgram()!
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed')
    }
    gl.useProgram(program)
    gl.disable(gl.DITHER)

    // Maze coordinates are y-down. Nonzero bounds also exercise reservoir-style
    // negative coordinates. Each .1-cell wall occupies about three texels.
    const size = 64
    const pixels = new Uint8Array(size * size)
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const x = -1 + (col + 0.5) * 2 / size
        const y = -1 + (row + 0.5) * 2 / size
        const vertical = Math.abs(x) <= 0.05 && Math.abs(y) >= 0.2
        const horizontal = Math.abs(y - 0.5) <= 0.05 && (x <= 0.5 || x >= 0.9)
        pixels[row * size + col] = vertical || horizontal ? 255 : 0
      }
    }
    const texture = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, pixels)
    gl.uniform1i(gl.getUniformLocation(program, 'uWalls'), 0)
    gl.uniform4f(gl.getUniformLocation(program, 'uWallBounds'), -1, -1, 2, 2)

    // All segment lengths are within a splat's support. Both endpoints remain
    // in air, so a successful rejection must detect the intervening wall.
    const cases = [
      { name: 'vertical wall forward', path: [-0.17, -0.6, 0.17, -0.6], clear: false },
      { name: 'vertical wall reverse', path: [0.17, -0.6, -0.17, -0.6], clear: false },
      { name: 'vertical wall diagonal', path: [-0.16, -0.68, 0.16, -0.52], clear: false },
      { name: 'vertical wall diagonal reverse', path: [0.16, -0.52, -0.16, -0.68], clear: false },
      { name: 'horizontal wall forward', path: [-0.6, 0.33, -0.6, 0.67], clear: false },
      { name: 'horizontal wall reverse', path: [-0.6, 0.67, -0.6, 0.33], clear: false },
      { name: 'horizontal wall diagonal', path: [-0.68, 0.34, -0.52, 0.66], clear: false },
      { name: 'horizontal wall diagonal reverse', path: [-0.52, 0.66, -0.68, 0.34], clear: false },
      { name: 'vertical passage', path: [-0.17, 0, 0.17, 0], clear: true },
      { name: 'vertical passage near wall end', path: [-0.17, -0.17, 0.17, -0.17], clear: true },
      { name: 'horizontal passage', path: [0.7, 0.33, 0.7, 0.67], clear: true },
      { name: 'same side of vertical wall', path: [-0.22, -0.6, -0.15, -0.4], clear: true },
      { name: 'same side of horizontal wall', path: [-0.6, 0.71, -0.4, 0.78], clear: true },
      { name: 'stationary in air', path: [-0.4, -0.4, -0.4, -0.4], clear: true },
    ]
    const samples = cases.map(({ name, path, clear }) => {
      gl.uniform4fv(gl.getUniformLocation(program, 'path'), path)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const pixel = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      return { name, clear, visible: pixel[0], fromSolid: pixel[1], toSolid: pixel[2] }
    })
    const error = gl.getError()
    gl.deleteTexture(texture)
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { samples, error }
  }, WATER_WALL_VISIBILITY)

  for (const sample of results.samples) {
    expect(sample.fromSolid, `${sample.name}: source is in air`).toBe(0)
    expect(sample.toSolid, `${sample.name}: target is in air`).toBe(0)
    expect(sample.visible, sample.name).toBe(sample.clear ? 255 : 0)
  }
  expect(results.error).toBe(0)
})
