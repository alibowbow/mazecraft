import React from 'react'
import ReactDOM from 'react-dom/client'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import { App } from './app/App'
import { installChunkRecovery } from './app/chunkRecovery'
import { ErrorBoundary } from './app/ErrorBoundary'
import './styles.css'

installChunkRecovery()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
