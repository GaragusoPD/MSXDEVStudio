import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import { withVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import globals from 'globals'

export default withVueTs(
  // The demo projects are MSX C and MSXgl build config, not repo JavaScript:
  // `project_config.js` is a script MSXgl evaluates with its own globals, which
  // `no-undef` rejects on sight.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', 'demo_msx1/**', 'demo_msx2/**'] },
  js.configs.recommended,
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  }
)
