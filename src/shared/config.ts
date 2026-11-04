export const DEFAULT_DSH_SETTINGS = {
  dshGateway: 'http://localhost:8080',
  dshKey: '',
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:7b',
  },
  cloud: {
    gatewayUrl: 'http://localhost:80/v1',
    apiKey: '',
  },
  gpu: {
    baseUrl: 'https://api.run.ai',
    token: '',
    agentPool: '',
    agentImage: 'nvidia/nemo:latest',
  },
  nim: {
    baseUrl: 'https://ai.api.nvidia.com',
    apiKey: '',
  },
} as const;
