import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Dev-server config picked up by bare `vite` (the `dev` script). The production
// bundles are built with explicit `--config vite.settings.config.ts` /
// `vite.editor.config.ts`, which take precedence and are unaffected by this file. It carries the
// same `@shared` alias so `settings/components/mission-control/floorModel.ts`
// (`import ... from '@shared/project'`) resolves under the dev server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'settings'),
      '@shared': resolve(__dirname, '../src/shared'),
    },
  },
})
