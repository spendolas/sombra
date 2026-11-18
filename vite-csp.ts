import type { Plugin } from 'vite'

// Production-only Content-Security-Policy, injected as a <meta> (GitHub Pages can't
// set headers). Dev is excluded: Vite HMR and react-refresh need inline scripts.
// Everything the app loads is same-origin (bundled workers, wasm, local fonts), so
// the policy is tight: no remote scripts, no inline scripts, no plugins, no <base>.
// 'wasm-unsafe-eval' = the oxipng/PNG wasm; style 'unsafe-inline' = React/Flow style
// attributes. frame-ancestors can't be set via meta, and viewer.html must stay
// frameable anyway (it is the embed target). Gate: npm run verify:csp.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  }
}
