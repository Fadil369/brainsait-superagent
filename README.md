# @brainsait/superagent

Multi-brain agent router — Ollama local, AI Gateway cloud, run:ai GPU, and NVIDIA NIM microservices.

## Structure

```
src/
├── brains/       # Brain implementations (local, cloud, gpu, nim)
├── executor/     # DSH superagent executor
├── lark/         # Lark integration
├── router/       # Model routing logic
├── shared/       # Types, config, utilities
└── web/          # Web panel frontend
```

## Setup

```sh
pnpm install
cp .env.example .env   # then edit
pnpm dev
```
