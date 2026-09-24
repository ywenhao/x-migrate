/// <reference types="vite/client" />

declare module '*.vue' {
  import type { Component } from 'vue'
  const component: Component
  export default component
}

declare module '*.json' {
  const value: any
  export default value
}
