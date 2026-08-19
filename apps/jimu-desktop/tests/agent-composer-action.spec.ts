// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentComposerAction } from '../../jimu-ui-preview/src/agent-composer-action.jsx'

interface ComposerAction {
  mode: 'idle' | 'submitting' | 'running' | 'cancelling'
  running: boolean
  submitting: boolean
  cancelling: boolean
  pending: boolean
  label: string
  disabled: boolean
}

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  if (root !== undefined) {
    act(() => { root?.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
})

function renderAction(action: ComposerAction) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onSend = vi.fn()
  const onStop = vi.fn()
  act(() => { root?.render(createElement(AgentComposerAction, { action, onSend, onStop })) })
  const button = host.querySelector('button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('composer action button did not render')
  return { button, onSend, onStop }
}

describe('JiMu composer action', () => {
  it('renders Send only for an idle action', () => {
    const { button, onSend, onStop } = renderAction({
      mode: 'idle', running: false, submitting: false, cancelling: false,
      pending: false, label: '发送消息', disabled: false,
    })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(button.querySelector('[data-action-icon="send"]')).not.toBeNull()
    act(() => { button.click() })
    expect(onSend).toHaveBeenCalledOnce()
    expect(onStop).not.toHaveBeenCalled()
  })

  it.each(['submitting', 'running'] as const)('offers Stop while the session is %s', (mode) => {
    const { button, onStop } = renderAction({
      mode,
      running: mode === 'running',
      submitting: mode === 'submitting',
      cancelling: false,
      pending: true,
      label: '停止生成',
      disabled: false,
    })
    expect(button.getAttribute('data-cancel')).toBe('true')
    expect(button.querySelector('[data-action-icon="stop"]')).not.toBeNull()
    expect(button.querySelector('.composer-stop-spinner')).not.toBeNull()
    act(() => { button.click() })
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('disables repeat cancellation while the authoritative session is settling', () => {
    const { button, onStop } = renderAction({
      mode: 'cancelling', running: true, submitting: false, cancelling: true,
      pending: true, label: '正在停止', disabled: true,
    })
    expect(button.disabled).toBe(true)
    act(() => { button.click() })
    expect(onStop).not.toHaveBeenCalled()
  })
})
