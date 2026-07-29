import { describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  ProjectImportError,
  createDefaultProject,
  deserializeProject,
  migrateProject,
  serializeProject,
} from './index'

describe('project serialization and migration', () => {
  it('round-trips a current MazeProject', () => {
    const project = createDefaultProject({
      id: 'round-trip',
      title: '직렬화 미로',
      seed: 'serialization',
    })
    const restored = deserializeProject(serializeProject(project))
    expect(restored.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(restored.id).toBe('round-trip')
    expect(restored.title).toBe('직렬화 미로')
    expect(restored.mazeGraph).toEqual(project.mazeGraph)
    expect(restored.startCell).toEqual(project.startCell)
    expect(restored.endCell).toEqual(project.endCell)
  })

  it('migrates a schema-less legacy project', () => {
    const source = createDefaultProject({
      title: '예전 미로',
      seed: 'legacy',
    })
    const migrated = migrateProject({
      title: source.title,
      seed: source.seed,
      maze: source.mazeGraph,
      start: source.startCell,
      end: source.endCell,
    })
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.title).toBe(source.title)
    expect(migrated.mazeGraph.cells).toHaveLength(
      source.mazeGraph.rows * source.mazeGraph.cols,
    )
  })

  it('rejects invalid JSON and oversized files without crashing', () => {
    expect(() => deserializeProject('{bad json')).toThrow(ProjectImportError)
    expect(() =>
      deserializeProject('{"large":"payload"}', { maximumBytes: 2 }),
    ).toThrowError(expect.objectContaining({ code: 'file-too-large' }))
  })

  it('drops external image URLs from imported projects', () => {
    const source = createDefaultProject({ seed: 'unsafe-image-url' })
    const migrated = migrateProject({
      ...source,
      shape: {
        kind: 'image',
        settings: {
          dataUrl: 'https://tracker.invalid/maze.png',
          mediaType: 'image/png',
        },
      },
      background: {
        kind: 'image',
        dataUrl: '//tracker.invalid/background.png',
        opacity: 1,
        fit: 'cover',
      },
      secretReveal: {
        mode: 'on-complete',
        animation: 'fade',
        content: {
          kind: 'image',
          imageDataUrl: 'https://tracker.invalid/secret.png',
          alt: 'unsafe',
        },
      },
    })

    expect(migrated.shape.kind).toBe('basic')
    expect(migrated.background.kind).toBe('solid')
    expect(migrated.secretReveal.content.kind).toBe('none')
    expect(serializeProject(migrated)).not.toContain('tracker.invalid')
  })

  it('rejects active or externally-referencing SVG data URLs', () => {
    const source = createDefaultProject({ seed: 'unsafe-svg' })
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<script>document.body.dataset.pwned="yes"</script>',
      '<image href="https://tracker.invalid/pixel.png"/>',
      '</svg>',
    ].join('')
    const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`
    const migrated = migrateProject({
      ...source,
      background: {
        kind: 'image',
        dataUrl,
        opacity: 1,
        fit: 'cover',
      },
      secretReveal: {
        mode: 'on-complete',
        animation: 'fade',
        content: {
          kind: 'image-message',
          imageDataUrl: dataUrl,
          alt: 'unsafe',
          message: '메시지',
        },
      },
    })

    expect(migrated.background.kind).toBe('solid')
    expect(migrated.secretReveal.content.kind).toBe('none')
  })

  it('keeps supported base64 raster image data', () => {
    const source = createDefaultProject({ seed: 'safe-image' })
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const migrated = migrateProject({
      ...source,
      background: {
        kind: 'image',
        dataUrl,
        opacity: 0.6,
        fit: 'contain',
      },
    })

    expect(migrated.background).toEqual({
      kind: 'image',
      dataUrl,
      opacity: 0.6,
      fit: 'contain',
    })
  })

  it('keeps a passive self-contained SVG image', () => {
    const source = createDefaultProject({ seed: 'safe-svg' })
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><clipPath id="clip"><circle cx="5" cy="5" r="4"/></clipPath></defs><rect width="10" height="10" fill="#123456" clip-path="url(#clip)"/></svg>'
    const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`
    const migrated = migrateProject({
      ...source,
      background: {
        kind: 'image',
        dataUrl,
        opacity: 1,
        fit: 'cover',
      },
    })

    expect(migrated.background).toEqual({
      kind: 'image',
      dataUrl,
      opacity: 1,
      fit: 'cover',
    })
  })
})
