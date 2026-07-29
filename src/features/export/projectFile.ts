import type { MazeProject } from '../../core/maze/types'
import {
  deserializeProject,
  serializeProject,
} from '../../core/maze/serialization'

export const PROJECT_FILE_EXTENSION = '.mazecraft'
export const MAX_PROJECT_FILE_SIZE = 25 * 1024 * 1024

export function sanitizeFilename(value: string, fallback = 'maze'): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (normalized || fallback).slice(0, 100)
}

export function projectFileName(project: MazeProject): string {
  return `${sanitizeFilename(project.title, 'maze')}${PROJECT_FILE_EXTENSION}`
}

export function createProjectFile(project: MazeProject): Blob {
  return new Blob([serializeProject(project, true)], {
    type: 'application/vnd.mazecraft+json;charset=utf-8',
  })
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')), {
      once: true,
    })
    reader.addEventListener(
      'error',
      () =>
        reject(reader.error ?? new Error('프로젝트 파일을 읽을 수 없습니다.')),
      { once: true },
    )
    reader.readAsText(blob)
  })
}

export async function readProjectFile(file: Blob): Promise<MazeProject> {
  if (file.size > MAX_PROJECT_FILE_SIZE) {
    throw new Error('프로젝트 파일은 25MB 이하만 열 수 있습니다.')
  }

  try {
    return deserializeProject(await readBlobText(file), {
      maximumBytes: MAX_PROJECT_FILE_SIZE,
    })
  } catch (cause) {
    if (cause instanceof Error) throw cause
    throw new Error('프로젝트 파일을 읽을 수 없습니다.')
  }
}
