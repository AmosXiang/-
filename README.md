<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.
https://ai.studio/apps/dc35e0da-a407-43b6-bf7e-ffd293baa8f7

## Run Locally

### Windows 一键启动

直接双击项目根目录的 `启动工具.bat`。它会启动网页、后端和已配置的 ComfyUI，并在网页就绪后自动打开浏览器。关闭启动窗口即可停止网页服务。

如果提示缺少项目依赖，请先在项目目录运行一次 `npm install`。

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Local ComfyUI image generation

1. Start ComfyUI (normally at `http://127.0.0.1:8188`) and make sure it has at least one checkpoint.
2. Copy the ComfyUI settings from `.env.example` into your local `.env` file.
3. In the storyboard UI, choose **ComfyUI (本地)** from the image platform menu.

Without a custom workflow, the server submits a standard checkpoint text-to-image workflow. To use SDXL, Flux, LoRA, ControlNet, or another custom graph, export the workflow from ComfyUI in **API format** and save it as `comfyui_workflow.json` in the project root. Node IDs can be configured in `.env`; prompt, negative-prompt, sampler/seed, checkpoint, and latent-size nodes are auto-detected when possible.

Completed images are copied into `uploads/projects/<projectId>/`, so saved storyboards do not depend on ComfyUI retaining its output directory. Generation times out after five minutes by default and can be adjusted with `COMFYUI_TIMEOUT_SECONDS`.

### ComfyUI acceptance test

Start the app and ComfyUI, create or select a project containing exactly one character and five shots, then run:

```bash
npm run test:comfyui:e2e -- <projectId>
```

The test records one expected failed request, then generates one character image and all five shot images. It persists each result and its prompt, negative prompt, seed, model, dimensions, target, status, and timestamp in SQLite. Generated files are stored under `uploads/projects/<projectId>/`.
