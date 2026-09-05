import { expect, test } from '@playwright/test'
import {
  WATER_ATLAS_COORDINATES,
  WATER_WORLD_SLOPE,
} from '../src/features/waterSimulation/rendering/waterSurfaceMath'

test('water GPU coordinates follow clockwise portals and camera-independent slopes', async ({ page }) => {
  await page.goto('/')
  const results = await page.evaluate(({ coordinates, slope }) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const gl = canvas.getContext('webgl2')!
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
      uniform float mode;
      uniform float orientation;
      uniform vec4 inputValue;
      uniform vec2 heights;
      out vec4 color;
      ${coordinates}
      ${slope}
      void main() {
        vec2 result;
        if (mode < 0.5) {
          result = blenderRotateToCanonical(inputValue.xy, orientation) - 0.5;
        } else if (mode < 1.5) {
          result = blenderNormalToWorld(inputValue.xy, orientation);
        } else if (mode < 2.5) {
          result = vec2(blenderTravelCycles(inputValue.xyz, vec2(inputValue.w, orientation)), 0.0);
        } else {
          result = waterWorldSlope(inputValue.xy, inputValue.zw, heights.x, heights.y);
        }
        color = vec4(result * 0.5 + 0.5, 0.0, 1.0);
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
    const render = (mode: number, orientation: number, input: number[], heights = [0, 0]) => {
      gl.uniform1f(gl.getUniformLocation(program, 'mode'), mode)
      gl.uniform1f(gl.getUniformLocation(program, 'orientation'), orientation)
      gl.uniform4fv(gl.getUniformLocation(program, 'inputValue'), input)
      gl.uniform2fv(gl.getUniformLocation(program, 'heights'), heights)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const pixel = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      return [pixel[0] / 255 * 2 - 1, pixel[1] / 255 * 2 - 1]
    }
    // The canonical top portal rotates through right, bottom and left.
    const portals = [[0.5, 1], [1, 0.5], [0.5, 0], [0, 0.5]]
    const canonical = portals.map(([x, y], turn) => render(0, turn, [x, y, 0, 0]))
    const normals = portals.map((_, turn) => render(1, turn, [0, 0.5, 0, 0]))
    const outletForward = render(2, 0, [0, -0.25, 0.25, 6])
    const outletReverse = render(2, 0, [0, 0.25, 0.25, 6])
    const rotatedForward = render(2, 1, [-0.25, 0, 0.25, 0])
    // All these cameras observe the same world height field h=.3*x-.2*y.
    const cameras = [[1, 0, 0, 1], [0, 0.1, -0.05, 0], [0.04, 0.03, -0.01, 0.06]]
    const slopes = cameras.map(([xx, xy, yx, yy]) => render(
      3, 0, [xx, xy, yx, yy], [xx * 0.3 - xy * 0.2, yx * 0.3 - yy * 0.2],
    ))
    const degenerateSlope = render(3, 0, [1, 1, 2, 2], [0.1, 0.2])
    const error = gl.getError()
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { canonical, normals, outletForward, outletReverse, rotatedForward, slopes, degenerateSlope, error }
  }, { coordinates: WATER_ATLAS_COORDINATES, slope: WATER_WORLD_SLOPE })

  const near = (actual: number[], expected: number[]) => {
    actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThan(0.009))
  }
  results.canonical.forEach(value => near(value, [0, 0.5]))
  results.normals.forEach((value, index) => near(value, [[0, 0.5], [0.5, 0], [0, -0.5], [-0.5, 0]][index]))
  near(results.outletForward, [0.25, 0])
  near(results.outletReverse, [-0.25, 0])
  near(results.rotatedForward, [0.25, 0])
  results.slopes.forEach(value => near(value, [0.3, -0.2]))
  near(results.degenerateSlope, [0, 0])
  expect(results.error).toBe(0)
})
