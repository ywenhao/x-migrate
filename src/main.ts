import { createVaporApp } from 'vue'
import App from './App.vue'
import { i18n, saveLocale } from './i18n'
import './style.css'

const app = createVaporApp(App)
app.use(i18n)
saveLocale(i18n.global.locale.value)
app.mount('#app')
