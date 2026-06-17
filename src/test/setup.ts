// Vitest global setup. Tests run under the Node environment (vite.config.ts
// `environment: 'node'`) because the handler/registry/ark layers are pure and
// must stay importable without React or the DOM.
//
// Intentionally empty for now — a seam for future global mocks/polyfills.
export {};
