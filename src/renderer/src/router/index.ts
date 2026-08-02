import { createRouter, createWebHashHistory } from 'vue-router'
import ExamplesPanel from '../components/ExamplesPanel.vue'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import GitPanel from '../components/GitPanel.vue'
import ResourcesPanel from '../components/ResourcesPanel.vue'
import RunPanel from '../components/RunPanel.vue'
import SearchPanel from '../components/SearchPanel.vue'
import ToolchainSettings from '../components/ToolchainSettings.vue'

/**
 * Drives the side panel only: the activity bar navigates between these
 * routes to swap what's shown in <SidePanel>. The editor area (tabs +
 * Welcome screen) is intentionally NOT routed — open files/tabs are dynamic
 * content the router has no static path for, so EditorArea renders them
 * directly from tabsStore instead.
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/explorer' },
    {
      path: '/explorer',
      name: 'explorer',
      component: ExplorerPanel
    },
    {
      path: '/search',
      name: 'search',
      component: SearchPanel
    },
    {
      path: '/git',
      name: 'git',
      component: GitPanel
    },
    {
      path: '/resources',
      name: 'resources',
      component: ResourcesPanel
    },
    {
      path: '/run',
      name: 'run',
      component: RunPanel
    },
    {
      path: '/examples',
      name: 'examples',
      component: ExamplesPanel
    },
    {
      path: '/settings',
      name: 'settings',
      component: ToolchainSettings
    }
  ]
})
