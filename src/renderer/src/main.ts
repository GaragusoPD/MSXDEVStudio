import './theme.css'
import './icons.css'
import './editors/bootstrap'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { router } from './router'
import App from './App.vue'

// A webfont is only fetched once an element using it is rendered, and the
// licence gate holds every `.icon` back until the user accepts — at which point
// the font request competes with the workbench opening a project, while
// `font-display: block` (see icons.css) draws nothing until it lands. Asking
// for it here puts the fetch back at startup, where it was before the gate.
void document.fonts.load('22px "Material Symbols Outlined"')

createApp(App).use(createPinia()).use(router).mount('#app')
