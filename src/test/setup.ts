import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// The physics suites run long synchronous simulations back to back. Yield to
// the event loop between tests so the worker answers the runner's RPC calls
// instead of timing them out.
afterEach(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
