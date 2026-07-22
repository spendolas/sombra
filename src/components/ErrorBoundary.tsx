/**
 * ErrorBoundary — contains a render error to its subtree instead of letting it
 * unmount the whole React app (a single throwing node display used to white-screen
 * the entire editor). Wrap custom node components + the app root.
 */
import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  /** Shown in place of the subtree when it throws. Defaults to nothing. */
  fallback?: ReactNode
  /** Label for the console log, e.g. the node type. */
  label?: string
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[Sombra] render error${this.props.label ? ` in ${this.props.label}` : ''}:`,
      error,
      info.componentStack,
    )
  }

  render() {
    if (this.state.hasError) return this.props.fallback ?? null
    return this.props.children
  }
}
