import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { spawn } from 'child_process';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Custom Vite plugin to launch the Express backend on dev server startup
function expressServerPlugin() {
  return {
    name: 'express-server',
    configureServer() {
      console.log('[Vite Plugin] Starting Express backend server...');
      const child = spawn('npx', ['tsx', 'server.ts'], {
        stdio: 'inherit',
        shell: true
      });
      process.on('exit', () => child.kill());
      process.on('SIGINT', () => {
        child.kill();
        process.exit();
      });
      process.on('SIGTERM', () => {
        child.kill();
        process.exit();
      });
    }
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(), 
      tailwindcss(),
      expressServerPlugin()
    ],
    resolve: {
      alias: {
        '@': path.resolve(projectRoot),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/uploads': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/db.json', '**/uploads/**']
      },
    },
  };
});
