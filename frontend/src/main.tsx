import { Buffer } from 'buffer'
globalThis.Buffer = Buffer

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Landing } from './Landing.tsx'
import { Docs } from './Docs.tsx'

const path = window.location.pathname
const isApp  = path.startsWith('/app')
const isDocs = path.startsWith('/docs')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isApp ? <App /> : isDocs ? <Docs /> : <Landing />}
  </StrictMode>,
)
