/// <reference types="vite/client" />

/** package.json version, injected at build time. */
declare const __APP_VERSION__: string
/** Short commit of the deployed build, when the host provides one. */
declare const __APP_COMMIT__: string

interface ImportMetaEnv {
  /** Feedback link for testers. Empty hides it. */
  readonly VITE_FEEDBACK_URL?: string
}
