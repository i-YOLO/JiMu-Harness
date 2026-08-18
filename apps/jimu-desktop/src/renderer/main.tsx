import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@jimu-preview/App.jsx'
import '@jimu-preview/styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('JiMu renderer root is missing')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
