import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@jimu-preview/App.jsx'
import '@jimu-preview/styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('JiMu renderer root is missing')
const platform = globalThis.window.jimu?.platform
if (platform !== undefined) document.documentElement.dataset.jimuPlatform = platform

createRoot(root).render(
  <React.StrictMode>
    <div className="windows-titlebar-drag-region" aria-hidden="true" />
    <App />
  </React.StrictMode>,
)
