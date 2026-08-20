export const BLENDER_WATER_MANIFEST_SCHEMA_VERSION = 1 as const

export const BLENDER_WATER_TILE_NAMES = [
  'straight',
  'corner',
  'tee',
  'cross',
  'dead_end',
  'source',
  'outlet',
  'pool',
] as const

export type BlenderWaterTileName =
  (typeof BLENDER_WATER_TILE_NAMES)[number]

export interface BlenderWaterTileRow {
  readonly name: BlenderWaterTileName
  readonly row: number
}

export interface BlenderWaterAtlasManifest {
  readonly schemaVersion: typeof BLENDER_WATER_MANIFEST_SCHEMA_VERSION
  readonly generator: {
    readonly name: string
    readonly version: string
    readonly mode: string
  }
  readonly atlas: {
    readonly file: string
    readonly width: number
    readonly height: number
    readonly tileSize: number
    readonly frames: number
    readonly rows: number
    readonly frameRate: number
    readonly colorSpace: 'linear'
  }
  readonly runtime: {
    readonly heightStrength: number
    readonly normalStrength: number
    readonly foamStrength: number
  }
  readonly channels: {
    readonly r: 'normalX'
    readonly g: 'normalY'
    readonly b: 'height'
    readonly a: 'foam'
  }
  readonly tiles: readonly BlenderWaterTileRow[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (
  record: Record<string, unknown>,
  key: string,
): string => {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${key} must be a non-empty string.`)
  }
  return value
}

const requireFiniteNumber = (
  record: Record<string, unknown>,
  key: string,
  minimum: number,
): number => {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${key} must be a finite number >= ${minimum}.`)
  }
  return value
}

const requirePositiveInteger = (
  record: Record<string, unknown>,
  key: string,
): number => {
  const value = requireFiniteNumber(record, key, 1)
  if (!Number.isInteger(value)) {
    throw new TypeError(`${key} must be an integer.`)
  }
  return value
}

/** Validates the generated Blender manifest before any texture is requested. */
export function parseBlenderWaterManifest(
  value: unknown,
): BlenderWaterAtlasManifest {
  if (!isRecord(value)) {
    throw new TypeError('Blender water manifest must be an object.')
  }
  if (value.schemaVersion !== BLENDER_WATER_MANIFEST_SCHEMA_VERSION) {
    throw new RangeError(
      `Unsupported Blender water manifest schema: ${String(value.schemaVersion)}`,
    )
  }
  if (!isRecord(value.generator)) {
    throw new TypeError('generator must be an object.')
  }
  if (!isRecord(value.atlas)) {
    throw new TypeError('atlas must be an object.')
  }
  if (!isRecord(value.runtime)) {
    throw new TypeError('runtime must be an object.')
  }
  if (!isRecord(value.channels)) {
    throw new TypeError('channels must be an object.')
  }

  const atlasFile = requireString(value.atlas, 'file')
  if (atlasFile.includes('..') || atlasFile.startsWith('/')) {
    throw new RangeError('atlas.file must be a relative file inside water-baked.')
  }
  const width = requirePositiveInteger(value.atlas, 'width')
  const height = requirePositiveInteger(value.atlas, 'height')
  const tileSize = requirePositiveInteger(value.atlas, 'tileSize')
  const frames = requirePositiveInteger(value.atlas, 'frames')
  const rows = requirePositiveInteger(value.atlas, 'rows')
  const frameRate = requireFiniteNumber(value.atlas, 'frameRate', 0.001)
  if (width !== tileSize * frames) {
    throw new RangeError('atlas.width must equal tileSize × frames.')
  }
  if (height !== tileSize * rows) {
    throw new RangeError('atlas.height must equal tileSize × rows.')
  }
  if (rows !== BLENDER_WATER_TILE_NAMES.length) {
    throw new RangeError(
      `atlas.rows must equal ${BLENDER_WATER_TILE_NAMES.length}.`,
    )
  }
  if (value.atlas.colorSpace !== 'linear') {
    throw new RangeError('atlas.colorSpace must be linear.')
  }

  const rawTiles = value.tiles
  if (
    !Array.isArray(rawTiles) ||
    rawTiles.length !== BLENDER_WATER_TILE_NAMES.length
  ) {
    throw new TypeError('tiles must contain the eight canonical tile rows.')
  }
  const parsedTiles: BlenderWaterTileRow[] = rawTiles.map((tile, index) => {
    if (!isRecord(tile)) {
      throw new TypeError(`tiles[${index}] must be an object.`)
    }
    const expectedName = BLENDER_WATER_TILE_NAMES[index]
    if (tile.name !== expectedName || tile.row !== index) {
      throw new RangeError(
        `tiles[${index}] must be ${expectedName} at row ${index}.`,
      )
    }
    return Object.freeze({ name: expectedName, row: index })
  })

  const expectedChannels = {
    r: 'normalX',
    g: 'normalY',
    b: 'height',
    a: 'foam',
  } as const
  for (const [channel, meaning] of Object.entries(expectedChannels)) {
    if (value.channels[channel] !== meaning) {
      throw new RangeError(`channels.${channel} must be ${meaning}.`)
    }
  }

  const heightStrength = requireFiniteNumber(
    value.runtime,
    'heightStrength',
    0,
  )
  const normalStrength = requireFiniteNumber(
    value.runtime,
    'normalStrength',
    0,
  )
  const foamStrength = requireFiniteNumber(
    value.runtime,
    'foamStrength',
    0,
  )
  for (const [name, strength] of [
    ['heightStrength', heightStrength],
    ['normalStrength', normalStrength],
    ['foamStrength', foamStrength],
  ] as const) {
    if (strength > 2) {
      throw new RangeError(`runtime.${name} must be <= 2.`)
    }
  }

  return Object.freeze({
    schemaVersion: BLENDER_WATER_MANIFEST_SCHEMA_VERSION,
    generator: Object.freeze({
      name: requireString(value.generator, 'name'),
      version: requireString(value.generator, 'version'),
      mode: requireString(value.generator, 'mode'),
    }),
    atlas: Object.freeze({
      file: atlasFile,
      width,
      height,
      tileSize,
      frames,
      rows,
      frameRate,
      colorSpace: 'linear' as const,
    }),
    runtime: Object.freeze({
      heightStrength,
      normalStrength,
      foamStrength,
    }),
    channels: Object.freeze(expectedChannels),
    tiles: Object.freeze(parsedTiles),
  })
}

export function resolveBlenderWaterManifestUrl(
  baseUrl =
    typeof document === 'undefined' ? 'http://localhost/' : document.baseURI,
): string {
  return new URL('water-baked/manifest.json', baseUrl).toString()
}
