import * as THREE from 'three'

const INSTALL_FLAG = '__mazeCraftWaterShaderEnhancerInstalled__' as const
const VERTEX_MARKER = '// MAZECRAFT_WATER_SURFACE_DYNAMICS_VERTEX'
const FRAGMENT_MARKER = '// MAZECRAFT_WATER_SURFACE_DYNAMICS_FRAGMENT'
const HISTORY_MARKER = '// MAZECRAFT_WATER_HISTORY_WALL_GUARD'

const TOPOLOGY_AWARE_STATE_SAMPLING = /* glsl */ `
  float topologyAxisConnection(vec2 fromCell, vec2 toCell) {
    vec2 fromCenter = (fromCell + 0.5) / uBoardSize;
    vec2 toCenter = (toCell + 0.5) / uBoardSize;
    vec2 portalCenter = (fromCenter + toCenter) * 0.5;
    float endpointMask = min(
      texture2D(uTopology, fromCenter).r,
      texture2D(uTopology, toCenter).r
    );
    float portalMask = texture2D(uTopology, portalCenter).r;
    return step(0.5, min(endpointMask, portalMask));
  }

  float topologyConnectionGate(vec2 fromCell, vec2 toCell) {
    vec2 delta = toCell - fromCell;
    vec2 absoluteDelta = abs(delta);
    float manhattanDistance = absoluteDelta.x + absoluteDelta.y;
    if (manhattanDistance < 0.5) return 1.0;
    if (
      absoluteDelta.x > 1.5 ||
      absoluteDelta.y > 1.5 ||
      manhattanDistance > 2.5
    ) return 0.0;
    if (manhattanDistance < 1.5) {
      return topologyAxisConnection(fromCell, toCell);
    }

    vec2 horizontalCorner = fromCell + vec2(delta.x, 0.0);
    vec2 verticalCorner = fromCell + vec2(0.0, delta.y);
    float horizontalRoute =
      topologyAxisConnection(fromCell, horizontalCorner) *
      topologyAxisConnection(horizontalCorner, toCell);
    float verticalRoute =
      topologyAxisConnection(fromCell, verticalCorner) *
      topologyAxisConnection(verticalCorner, toCell);
    return max(horizontalRoute, verticalRoute);
  }

  vec4 sampleDynamicStateSmooth(vec2 sampleUv) {
    vec2 boundedUv = clamp(
      sampleUv,
      vec2(0.0),
      vec2(0.999999)
    );
    vec2 position = boundedUv * uBoardSize - 0.5;
    vec2 base = floor(position);
    vec2 blend = fract(position);
    vec2 maximumCell = uBoardSize - 1.0;
    vec2 anchorCell = clamp(
      floor(boundedUv * uBoardSize),
      vec2(0.0),
      maximumCell
    );
    vec2 cell00 = clamp(base, vec2(0.0), maximumCell);
    vec2 cell10 = clamp(
      base + vec2(1.0, 0.0),
      vec2(0.0),
      maximumCell
    );
    vec2 cell01 = clamp(
      base + vec2(0.0, 1.0),
      vec2(0.0),
      maximumCell
    );
    vec2 cell11 = clamp(base + vec2(1.0), vec2(0.0), maximumCell);
    vec4 anchorState = texture2D(
      uDynamicState,
      (anchorCell + 0.5) / uBoardSize
    );
    vec4 state00 = texture2D(
      uDynamicState,
      (cell00 + 0.5) / uBoardSize
    );
    vec4 state10 = texture2D(
      uDynamicState,
      (cell10 + 0.5) / uBoardSize
    );
    vec4 state01 = texture2D(
      uDynamicState,
      (cell01 + 0.5) / uBoardSize
    );
    vec4 state11 = texture2D(
      uDynamicState,
      (cell11 + 0.5) / uBoardSize
    );
    state00 = mix(
      anchorState,
      state00,
      topologyConnectionGate(anchorCell, cell00)
    );
    state10 = mix(
      anchorState,
      state10,
      topologyConnectionGate(anchorCell, cell10)
    );
    state01 = mix(
      anchorState,
      state01,
      topologyConnectionGate(anchorCell, cell01)
    );
    state11 = mix(
      anchorState,
      state11,
      topologyConnectionGate(anchorCell, cell11)
    );
    return mix(
      mix(state00, state10, blend.x),
      mix(state01, state11, blend.x),
      blend.y
    );
  }
`

const HISTORY_BILINEAR_SOURCE = `  vec4 sampleSource(vec2 uv) {
    // Manual bilinear reconstruction keeps the hydraulic texture on nearest
    // filtering, which works even when float-linear filtering is unavailable.
    vec2 position =
      clamp(uv, vec2(0.0), vec2(1.0)) * uSourceSize - 0.5;
    vec2 base = floor(position);
    vec2 blend = fract(position);
    vec2 maximumCell = uSourceSize - 1.0;
    vec2 cell00 = clamp(base, vec2(0.0), maximumCell);
    vec2 cell10 = clamp(
      base + vec2(1.0, 0.0),
      vec2(0.0),
      maximumCell
    );
    vec2 cell01 = clamp(
      base + vec2(0.0, 1.0),
      vec2(0.0),
      maximumCell
    );
    vec2 cell11 = clamp(base + vec2(1.0), vec2(0.0), maximumCell);
    vec4 state00 = texture2D(uSource, (cell00 + 0.5) / uSourceSize);
    vec4 state10 = texture2D(uSource, (cell10 + 0.5) / uSourceSize);
    vec4 state01 = texture2D(uSource, (cell01 + 0.5) / uSourceSize);
    vec4 state11 = texture2D(uSource, (cell11 + 0.5) / uSourceSize);
    return mix(
      mix(state00, state10, blend.x),
      mix(state01, state11, blend.x),
      blend.y
    );
  }
`

const HISTORY_WALL_SAFE_SOURCE = `  ${HISTORY_MARKER}
  vec4 sampleSource(vec2 uv) {
    vec2 boundedUv = clamp(uv, vec2(0.0), vec2(0.999999));
    vec2 sourceCell = floor(boundedUv * uSourceSize);
    return texture2D(
      uSource,
      (sourceCell + 0.5) / uSourceSize
    );
  }
`

function replaceRequired(
  source: string,
  search: string,
  replacement: string,
): string | null {
  if (!source.includes(search)) return null
  return source.replace(search, replacement)
}

/** Adds smooth macro-state sampling and high-resolution history displacement. */
export function enhanceWaterVertexShader(source: string): string {
  if (source.includes(VERTEX_MARKER)) return source
  let next = replaceRequired(
    source,
    '  uniform sampler2D uDynamicState;\n',
    `  uniform sampler2D uDynamicState;\n  uniform sampler2D uFoamHistory;\n  uniform float uFoamHistoryEnabled;\n  ${VERTEX_MARKER}\n`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    '  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {\n',
    `${TOPOLOGY_AWARE_STATE_SAMPLING}
  float finiteDepthPhaseScale(float waveNumberPerCell, float normalizedDepth) {
`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    '    vec4 dynamicState = texture2D(uDynamicState, uv);\n',
    '    vec4 dynamicState = sampleDynamicStateSmooth(uv);\n',
  )
  if (!next) return source

  next = replaceRequired(
    next,
    '    vec3 transformed = position;\n',
    `    vec4 surfaceHistory = texture2D(uFoamHistory, uv);
    float historyGate = clamp(uFoamHistoryEnabled, 0.0, 1.0);
    float simulatedHeight = (surfaceHistory.g * 2.0 - 1.0) * historyGate;
    float simulatedVerticalVelocity =
      abs(surfaceHistory.b * 2.0 - 1.0) * historyGate;
    vec3 transformed = position;
`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    transformed.z += mask * (
      depth * (0.012 + wave * motion * mix(0.035, 0.12, motion)) -
      impactDimple * 0.026 +
      impactShoulder * 0.026
    );`,
    `    float hydraulicSurfaceHeight = depth * 0.12;
    float directionalWave =
      wave * motion * mix(0.0045, 0.018, motion);
    float microSurface = simulatedHeight * mix(
      0.026,
      0.057,
      smoothstep(0.015, 0.38, speed + simulatedVerticalVelocity)
    );
    transformed.z += mask * (
      hydraulicSurfaceHeight +
      directionalWave +
      microSurface -
      impactDimple * 0.018 +
      impactShoulder * 0.021
    );`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    vWaveCrest = max(
      clamp(wave / totalAmplitude * 0.5 + 0.5, 0.0, 1.0) * motion,
      impactShoulder * 0.72
    );`,
    `    vWaveCrest = max(
      max(
        clamp(wave / totalAmplitude * 0.5 + 0.5, 0.0, 1.0) * motion,
        impactShoulder * 0.72
      ),
      smoothstep(0.08, 0.34, simulatedVerticalVelocity)
    );`,
  )
  return next ?? source
}

/**
 * Upgrades the existing water shader with history normals, Beer-Lambert-style
 * absorption, turbulence-sensitive highlights and feathered advected foam.
 */
export function enhanceWaterFragmentShader(source: string): string {
  if (source.includes(FRAGMENT_MARKER)) return source
  let next = replaceRequired(
    source,
    '  uniform sampler2D uFoamHistory;\n',
    `  uniform sampler2D uFoamHistory;\n  ${FRAGMENT_MARKER}\n`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    '  void main() {\n',
    `${TOPOLOGY_AWARE_STATE_SAMPLING}
  void main() {
`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    '    vec4 dynamicState = texture2D(uDynamicState, vUv);\n',
    `    vec4 dynamicState = sampleDynamicStateSmooth(vUv);
    vec4 surfaceHistory = texture2D(uFoamHistory, vUv);
    float historyGate = clamp(uFoamHistoryEnabled, 0.0, 1.0);
    float simulatedHeight =
      (surfaceHistory.g * 2.0 - 1.0) * historyGate;
    float simulatedVerticalVelocity =
      abs(surfaceHistory.b * 2.0 - 1.0) * historyGate;
    float turbulence = surfaceHistory.a * historyGate;
`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    vec2 detailNormal =
      ((detailA.rg * 2.0 - 1.0) +
        (detailB.rg * 2.0 - 1.0) * 0.48) *
      uDetailStrength * motion;
    vec3 normal = normalize(vec3(
      geometricNormal.xy + detailNormal * 0.24,
      max(0.2, geometricNormal.z)
    ));`,
    `    float localMotion = clamp(
      0.11 + motion * 0.86 + turbulence * 0.43,
      0.0,
      1.35
    );
    vec2 detailNormal =
      ((detailA.rg * 2.0 - 1.0) +
        (detailB.rg * 2.0 - 1.0) * 0.48) *
      uDetailStrength * localMotion;
    vec2 simulatedSlope = vec2(
      dFdx(simulatedHeight),
      dFdy(simulatedHeight)
    ) * 7.2;
    vec3 normal = normalize(vec3(
      geometricNormal.xy + detailNormal * 0.19 - simulatedSlope,
      max(0.2, geometricNormal.z)
    ));`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    float glitter = pow(max(dot(reflectedSun, viewDirection), 0.0), 48.0) *
      uGlitterStrength;`,
    `    float glitterExponent = mix(76.0, 30.0, turbulence);
    float glitter = pow(
      max(dot(reflectedSun, viewDirection), 0.0),
      glitterExponent
    ) * uGlitterStrength * mix(0.82, 1.16, turbulence);`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    vec3 shallowCyan = vec3(0.025, 0.73, 0.9);
    vec3 deepBlue = vec3(0.005, 0.28, 0.59);
    vec3 bodyColor = mix(shallowCyan, deepBlue, smoothstep(0.08, 0.86, depth));
    bodyColor = mix(
      bodyColor,
      skyReflection,
      clamp(fresnel * uReflectionStrength, 0.0, 0.92)
    );
    bodyColor += vec3(0.82, 0.97, 1.0) * glitter;`,
    `    float depthMeters = depth * 0.24;
    vec3 absorptionCoefficient = vec3(4.2, 1.28, 0.38);
    vec3 transmittance = exp(-absorptionCoefficient * depthMeters);
    vec3 paleFloor = vec3(0.83, 0.91, 0.89);
    vec3 inScattering = vec3(0.008, 0.39, 0.53);
    vec3 refractedBody =
      paleFloor * transmittance +
      inScattering * (vec3(1.0) - transmittance) * 0.88;
    vec3 bodyColor = mix(
      refractedBody,
      skyReflection,
      clamp(fresnel * uReflectionStrength, 0.0, 0.9)
    );
    bodyColor += vec3(0.82, 0.97, 1.0) * glitter;`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    bodyColor += vec3(0.04, 0.7, 0.68) * subsurface;
    bodyColor = mix(bodyColor, vec3(0.15, 0.76, 0.84), impactRing * 0.18);`,
    `    bodyColor += vec3(0.04, 0.7, 0.68) * subsurface;
    float microEnergy = smoothstep(
      0.015,
      0.3,
      abs(simulatedHeight) + simulatedVerticalVelocity * 0.82
    );
    float causticInterference =
      0.5 +
      0.5 * sin(
        simulatedHeight * 46.0 +
        channelUv.x * 1.17 -
        channelUv.y * 0.83 +
        uWaveTime * 2.6
      );
    float caustic =
      causticInterference *
      microEnergy *
      (1.0 - smoothstep(0.22, 0.94, depth));
    bodyColor += vec3(0.12, 0.72, 0.61) * caustic * 0.12;
    bodyColor = mix(
      bodyColor,
      vec3(0.15, 0.76, 0.84),
      impactRing * 0.15
    );`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    float bubbleStructure = mix(0.72, 1.08, detailA.b * detailB.a);
    float foamLighting = mix(0.82, 1.12, max(dot(normal, sunDirection), 0.0));`,
    `    float bubbleStructure = mix(
      0.7,
      1.1,
      detailA.b * detailB.a * mix(0.72, 1.0, turbulence)
    );
    float foamLighting = mix(
      0.82,
      1.12,
      max(dot(normal, sunDirection), 0.0)
    );`,
  )
  if (!next) return source

  next = replaceRequired(
    next,
    `    float alpha = mask * mix(0.38, 0.9, sqrt(depth));
    alpha = max(alpha, foam * mask * 0.76);`,
    `    float opticalAlpha = 1.0 - exp(-depth * 2.45);
    float alpha = mask * mix(0.24, 0.84, opticalAlpha);
    alpha = max(alpha, foam * mask * 0.78);`,
  )
  return next ?? source
}

/** Prevents the high-resolution history pass from blending through closed walls. */
export function enhanceWaterHistoryFragmentShader(source: string): string {
  if (source.includes(HISTORY_MARKER)) return source
  return replaceRequired(
    source,
    HISTORY_BILINEAR_SOURCE,
    HISTORY_WALL_SAFE_SOURCE,
  ) ?? source
}

function isMazeWaterSurface(material: THREE.ShaderMaterial): boolean {
  const uniforms = material.uniforms
  return Boolean(
    uniforms.uTopology &&
      uniforms.uDynamicState &&
      uniforms.uFoamHistory &&
      uniforms.uWaveTime &&
      uniforms.uFlowGate,
  )
}

function isMazeWaterHistory(material: THREE.ShaderMaterial): boolean {
  const uniforms = material.uniforms
  return Boolean(
    uniforms.uPrevious &&
      uniforms.uSource &&
      uniforms.uSourceSize &&
      uniforms.uSimulationSize &&
      uniforms.uDeltaSeconds &&
      !uniforms.uTopology,
  )
}

/** Installs one narrowly scoped compile hook for MazeCraft's water materials. */
export function installWaterShaderEnhancer(): void {
  type ShaderMaterialPrototype = typeof THREE.ShaderMaterial.prototype & {
    [INSTALL_FLAG]?: boolean
  }
  const prototype = THREE.ShaderMaterial.prototype as ShaderMaterialPrototype
  if (prototype[INSTALL_FLAG]) return
  prototype[INSTALL_FLAG] = true
  const original = prototype.onBeforeCompile
  type CompileParameters = Parameters<
    THREE.ShaderMaterial['onBeforeCompile']
  >

  const patched = function (
    this: THREE.ShaderMaterial,
    shader: CompileParameters[0],
    renderer: CompileParameters[1],
  ): void {
    original.call(this, shader, renderer)
    if (isMazeWaterSurface(this)) {
      shader.vertexShader = enhanceWaterVertexShader(shader.vertexShader)
      shader.fragmentShader = enhanceWaterFragmentShader(shader.fragmentShader)
      return
    }
    if (isMazeWaterHistory(this)) {
      shader.fragmentShader = enhanceWaterHistoryFragmentShader(
        shader.fragmentShader,
      )
    }
  }
  prototype.onBeforeCompile = patched
}

installWaterShaderEnhancer()
