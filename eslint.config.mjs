import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import { withVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import globals from 'globals'

export default withVueTs(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**'] },
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
