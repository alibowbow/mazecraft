/// <reference lib="webworker" />

import {
  candidateCountForSize,
  generateMazeCandidateAtIndex,
} from '../core/maze/generate'
import type {
  MazeCandidate,
  MazeWorkerRequest,
  MazeWorkerResponse,
} from '../core/maze/types'

const scope = self as unknown as DedicatedWorkerGlobalScope
const cancelled = new Set<string>()
const active = new Set<string>()

function post(response: MazeWorkerResponse): void {
  scope.postMessage(response)
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function generateInWorker(
  request: Extract<MazeWorkerRequest, { type: 'generate' }>,
): Promise<void> {
  const { requestId, payload } = request
  if (active.has(requestId)) {
    post({
      type: 'error',
      requestId,
      message: '같은 요청 ID의 미로 생성이 이미 진행 중입니다.',
    })
    return
  }

  active.add(requestId)
  cancelled.delete(requestId)
  try {
    const total = Math.max(
      1,
      Math.min(
        24,
        payload.candidateCount ??
          candidateCountForSize(payload.rows, payload.cols),
      ),
    )
    let best: MazeCandidate | undefined

    for (let candidateIndex = 0; candidateIndex < total; candidateIndex += 1) {
      if (cancelled.has(requestId)) {
        post({ type: 'cancelled', requestId })
        return
      }

      const candidate = generateMazeCandidateAtIndex(payload, candidateIndex)
      if (
        !best ||
        candidate.targetDistance < best.targetDistance ||
        (candidate.targetDistance === best.targetDistance &&
          candidate.candidateIndex < best.candidateIndex)
      ) {
        best = candidate
      }
      post({
        type: 'progress',
        requestId,
        progress: {
          requestId,
          completed: candidateIndex + 1,
          total,
          bestScore: best.targetDistance,
        },
      })

      // Yield to the worker event loop so a queued cancel message can be handled.
      await nextTask()
    }

    if (cancelled.has(requestId)) {
      post({ type: 'cancelled', requestId })
    } else if (best) {
      post({ type: 'complete', requestId, result: best })
    }
  } catch (error) {
    post({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : '미로 생성 중 오류가 발생했습니다.',
    })
  } finally {
    active.delete(requestId)
    cancelled.delete(requestId)
  }
}

scope.addEventListener('message', (event: MessageEvent<MazeWorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') {
    cancelled.add(request.requestId)
    return
  }
  void generateInWorker(request)
})

export {}
