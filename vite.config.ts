import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { spawn } from 'child_process';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// 端口方案:启动器(如 preview_start)注入 PORT 时,vite 用 PORT、Express 用 PORT+1、
// 代理跟随;不注入时保持历史默认(vite 3000 / Express 3001),手动 npm run dev 行为不变。
// 这让多个会话可以并行各起一套 dev(此前 vite 端口写死 3000、Express 抢 PORT 会互相冲突)。
const vitePort = Number(process.env.PORT) || 3000;
const apiPort = process.env.PORT ? Number(process.env.PORT) + 1 : 3001;

// Custom Vite plugin to launch the Express backend on dev server startup
function expressServerPlugin() {
  return {
    name: 'express-server',
    configureServer() {
      console.log(`[Vite Plugin] Starting Express backend server on port ${apiPort}...`);
      const child = spawn('npx', ['tsx', 'server.ts'], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, PORT: String(apiPort) }
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
      port: vitePort,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        '/uploads': {
          target: `http://localhost:${apiPort}`,
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
