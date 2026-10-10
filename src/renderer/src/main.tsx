import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installRendererErrorLogging } from './api'
import './styles.css'

installRendererErrorLogging()

const container = document.getElementById('root')
if (!container) throw new Error('Root element missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
