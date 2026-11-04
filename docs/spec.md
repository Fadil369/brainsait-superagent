# brainsait-superagent — Design Specification

## 1. Overview

brainsait-superagent is a multi-brain agent system that routes tasks across four specialist compute domains based on capability, cost, and confidence. It presents a unified conversation surface via Lark bot and a monitoring/audit interface via DSH web panel.

### Principles

- **Local-first**: 80% of tasks handled by local Ollama (zero cost, zero latency).
- **Escalate on uncertainty**: threshold-based handoff to GPU/cloud when local lacks capability.
- **Learn over time**: router improves its routing decisions based on outcome feedback.
- **Minimal context transfer**: cross-brain handoff uses structured `handoff.md` to avoid bloating upstream contexts.
- **Phased rollout**: deploy incrementally, validate each layer before adding complexity.

---

## 2. Architecture

```
                    ┌─────────────┐
                    │  Lark Bot   │  ← Primary conversation surface
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Super Agent│  ← Task intake, routing, orchestration
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌──▼────┐ ┌──────▼──────┐
        │ Local Brain│ │Cloud  │ │  GPU Brain  │ ─ Phase 3
        │  (Ollama)  │ │ Brain │ │  (Run:ai)   │
        │  qwen3:8b  │ │  (AI  │ └──────┬──────┘
        │  ~5.2 GB   │ │ GW)   │        │
        └────────────┘ └──┬────┘ ┌─────▼──────┐
                          │      │   NIM Brain│ ─ Phase 3
                          │      │  (NGC NIMs)│
                          └──────┴────────────┘

         ┌──────────────────────────────────────┐
         │   Shared: BrainSAIT Knowledge Graph  │ ← MCP cross-brain memory
         │   DSH Web Panel (monitor/audit)      │ ← Phased rollout view
         └──────────────────────────────────────┘
```

---

## 3. Components

### 3.1 Super Agent (Orchestrator)

- **Location**: Tailscale network, `fadil369@100.90.56.120` (brainsait Hetzner server)
- **Responsibilities**:
  - Receive user messages (Lark → webhook → agent)
  - Parse task intent and estimate capability match per brain
  - Delegate to appropriate brain
  - Collect response, format output, send back to Lark
  - Log all interactions to DSH web panel for audit

### 3.2 Local Brain — Ollama qwen3:8b

| Attribute    | Value                    |
|-------------|--------------------------|
| Model       | qwen3:8b                 |
| Size        | 5.2 GB                   |
| Host        | brainsait server (local) |
| Access      | `localhost:11434`        |
| Latency     | ~200-800ms first token   |
| Cost        | $0 (local GPU/CPU)       |
| Always-on   | Yes (systemd service)    |

**Handles**: Code review, text drafting, config edits, simple reasoning, file ops, shell commands, knowledge lookup, routine Lark responses.

### 3.3 GPU Brain — NVIDIA Run:ai via Brev

| Attribute    | Value                          |
|-------------|--------------------------------|
| Runtime     | On-demand A100/H100            |
| Access      | Brev service account / API     |
| Cost        | ~$3-5/hr (pay-per-use)         |
| Latency     | ~2-5s warmup + inference       |

**Handles**: Heavy coding tasks, large file analysis, benchmarking, model evaluation, PR auto-merge decisions with complex codebases, tasks exceeding local context or reasoning capacity.

### 3.4 Cloud Brain — AI Gateway

| Attribute   | Value                             |
|------------|-----------------------------------|
| Endpoint   | 100.110.98.65 (`/v1`)             |
| Models     | 18 models: Claude, GPT, Llama, etc.|
| Protocol   | OpenAI-compatible (`/v1/chat`)    |
| Access     | Tailscale private network          |
| Cost       | Per-token (model-dependent)        |

**Handles**: Tasks needing frontier model quality (complex reasoning, creative writing, nuanced analysis), model-specific requests (user asks for Claude/GPT explicitly).

### 3.5 NIM Brain — NVIDIA NIM Microservices

| Service      | Purpose                          | Access               |
|-------------|----------------------------------|----------------------|
| SGLang       | LLM inference (open weights)     | NGC / local NIM      |
| GenMol       | Molecule generation              | API.nvidia.com       |
| DiffDock     | Molecular docking                | API.nvidia.com       |
| Boltz2       | Protein structure prediction     | API.nvidia.com       |

**Handles**: Drug discovery pipelines, protein folding, molecular generation, domain-specific NIM workloads.

### 3.6 Shared Memory — BrainSAIT Knowledge Graph

- **Access**: 8 MCP tools via `MCP_DOCKER_*` namespace
- **Operations**: `read_graph`, `search_nodes`, `open_nodes`, `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_relations`
- **Purpose**: Persistent, queryable cross-brain memory. All brains read/write to shared graph for continuity.

### 3.7 Lark Bot (Conversation Surface)

- Receives messages via Lark Open API webhook
- Forwards to Super Agent
- Formats responses for Lark (card messages, rich text)
- Supports commands: `/help`, `/status`, `/brain`, `/reset`, `/model`

### 3.8 DSH Web Panel (Monitoring & Audit)

- Existing DeepSeek Harness web UI at `https://brainsait.opah-insen.ts.net`
- Extends to show:
  - Active conversation threads
  - Router decisions (which brain was chosen, why)
  - Confidence scores over time
  - Handoff chain visualization
  - Cost tracking per brain
  - Performance metrics (latency, tokens, success rate)

---

## 4. Data Flow

### 4.1 Standard Request Flow

```
User → Lark Bot → Super Agent → Router → [Local | GPU | Cloud | NIM] → Super Agent → Lark Bot → User
```

1. Lark receives message via webhook
2. Super Agent extracts: user_id, message, conversation_id, attached_files
3. Router evaluates task and selects brain
4. Selected brain processes task with context from shared memory
5. Response returned to Super Agent
6. Super Agent formats response (markdown, card, attachment)
7. Response sent to Lark
8. Interaction logged to DSH web panel

### 4.2 Cross-Brain Handoff Flow

When local brain determines a task exceeds its capability:

```
Local Brain
    │
    ├─ Detects: task complexity, missing domain knowledge, uncertain confidence
    │
    ├─ Writes handoff.md:
    │     │
    │     ├─ # Context Summary (what was done so far)
    │     ├─ # Task Description (what needs to be done)
    │     ├─ # Key Findings (what local brain discovered)
    │     ├─ # Constraints (budget, time, model preferences)
    │     └─ # Expected Output (format, scope)
    │
    ├─ Sends handoff.md + user message to selected brain
    │
    └─ Collects response, integrates back to conversation
```

Handoff is **transparent to the user** — they see one continuous conversation.

### 4.3 Knowledge Graph Flow

```
Super Agent ←→ MCP Bridge ←→ BrainSAIT Knowledge Graph
    │                   │
    ├─ Read: search_nodes, open_nodes, read_graph
    ├─ Write: create_entities, create_relations, add_observations
    └─ Sync: all brains can query/write independently
```

Each brain's significant findings are persisted as graph observations. This enables later sessions to pick up context without re-processing.

---

## 5. Router Logic

### 5.1 Routing Decision Model

The router uses a four-stage pipeline:

```
Stage 1: Capability Filter     → Which brain CAN handle this?
Stage 2: Confidence Estimate   → Which brain is MOST confident?
Stage 3: Threshold Check       → Is local's confidence sufficient?
Stage 4: Manual Override       → User preference takes final say
```

### 5.2 Confidence Scoring

Each brain returns a confidence score (0.0 - 1.0) based on:

- **Task-brain fit**: semantic similarity between task description and brain's known capabilities
- **Context adequacy**: shared memory contains sufficient history for this task type
- **Past performance**: historical success rate for similar tasks
- **Resource availability**: GPU/cloud/NIM endpoints are reachable

### 5.3 Threshold Rules

| Condition                        | Action                          |
|---------------------------------|---------------------------------|
| Local confidence ≥ 0.85          | Execute on Local Brain          |
| Local confidence 0.60 - 0.84     | Escalate to Cloud Brain         |
| Local confidence < 0.60          | Escalate to GPU Brain           |
| Task matches NIM domain          | Direct to NIM Brain             |
| User specified model/brain       | Override: use specified brain   |
| PR auto-merge (confidence ≥ 0.90)| Auto-merge without human review |
| PR confidence 0.70 - 0.89       | Human review required           |
| PR confidence < 0.70            | Escalate to GPU for review      |

### 5.4 Self-Learning

After each task completion:

1. **Outcome label**: success / partial / failure (from user feedback or auto-detected)
2. **Route correctness**: was the selected brain appropriate?
3. **Confidence calibration**: did confidence correlate with actual outcome?

Learning updates:
- **Weight adjustment**: brain-specific routing weights in Stage 2
- **Threshold adaptation**: confidence thresholds shift based on calibration error
- **Capability expansion**: new task-brain pairings recorded in knowledge graph

Implementation: `router/learning.py` — incremental weight updates, no full retraining.

---

## 6. Phased Build Plan

### Phase 1: Foundation (Local Brain + Interfaces)

**Goal**: Working agent with local brain, Lark bot, and DSH monitoring.

| Component              | Details                                              |
|-----------------------|------------------------------------------------------|
| Local Brain           | Ollama qwen3:8b, systemd service, health check       |
| Lark Bot              | Webhook receiver, message formatter, card messages   |
| Super Agent Core      | Task intake, basic routing (local only), response    |
| DSH Extension         | Add superagent route to existing DSH panel           |
| Shared Memory         | MCP bridge for local brain reads/writes              |

**Deliverables**: User can message Lark bot, get responses from local brain, view activity in DSH.

### Phase 2: Cloud Intelligence

**Goal**: Add cloud brain, router, and self-learning.

| Component              | Details                                              |
|-----------------------|------------------------------------------------------|
| Cloud Brain           | AI Gateway integration (100.110.98.65), model list   |
| Router                | Threshold-based routing, confidence scoring           |
| Self-Learning         | Outcome logging, weight updates, calibration tracking |
| Knowledge Graph       | Cross-brain memory writes, search, entity creation    |

**Deliverables**: Router decides between local and cloud. Router improves over time.

### Phase 3: GPU & NIM

**Goal**: Add GPU brain and NIM microservice brain.

| Component              | Details                                              |
|-----------------------|------------------------------------------------------|
| GPU Brain             | Brev API integration, instance provisioning, teardown |
| NIM Brain             | API.nvidia.com clients for GenMol, DiffDock, Boltz2  |
| Enhanced Router       | 4-brain routing, NIM domain detection                 |
| DSH Metrics           | Cost tracking, GPU instance lifecycle monitoring      |

**Deliverables**: Full 4-brain routing. Drug discovery tasks routed to NIM. Heavy tasks routed to GPU.

### Phase 4: Advanced Autonomy

**Goal**: Cross-brain handoff, PR workflow, learning optimizer.

| Component              | Details                                              |
|-----------------------|------------------------------------------------------|
| Handoff Protocol      | handoff.md generation, context transfer, response merge |
| PR Workflow           | Git integration, auto-review, confidence-based merge |
| Learning Optimizer    | Full calibration loop, threshold adaptation           |
| DSH Visualization     | Handoff chain view, router decision timeline          |

**Deliverables**: Fully autonomous agent with handoff, PR automation, and self-optimizing router.

---

## 7. Security

### 7.1 Network

- **Tailscale-only**: All inter-brain communication via Tailscale private network
- **HTTPS exposure**: `tailscale serve` for DSH web panel — no direct port exposure
- **SSH**: brainsait server via `ssh fadil369@100.90.56.120` (Tailscale SSH)
- **AI Gateway**: 100.110.98.65 accessible only within tailnet

### 7.2 Authentication

- **Lark Bot**: Lark Open API app credentials, webhook verification via Lark's HMAC signature
- **DSH Panel**: Tailscale-authenticated access, no public endpoint
- **GPU (Brev)**: Service account tokens, scoped to project
- **Cloud (AI Gateway)**: Gateway API keys via `DSH_GATEWAY_KEY` env var
- **NIM**: NGC API key, stored in `~/.secrets/` (not committed)

### 7.3 Data Protection

- No user data leaves tailscale network except via explicit brain API calls
- NIM calls transmit data to NVIDIA-hosted endpoints (documented in NIM skill)
- Shared memory uses BrainSAIT knowledge graph — user data is observations, not raw messages
- No secrets in logs, DSH panel, or conversation history

### 7.4 Rate Limits & Cost Controls

- Per-brain rate limiting via router config
- Daily budget cap (configurable, default: $20/day across all brains)
- GPU brain has explicit confirm-before-provision (unless user pre-approves)
- Cost logged per interaction in DSH panel

---

## 8. Deployment

### 8.1 Infrastructure

| Resource        | Host                        | Purpose                    |
|----------------|-----------------------------|----------------------------|
| brainsait       | 100.90.56.120 (Hetzner)     | Ollama, Super Agent, DSH   |
| ai node         | 100.110.98.65               | AI Gateway (model proxy)   |
| Brev instances  | On-demand (A100/H100)       | GPU brain                  |
| API.nvidia.com  | Cloud                       | NIM microservices          |
| Lark            | Cloud (webhook receiver)    | Conversation surface        |

### 8.2 Installation

```bash
# On brainsait server (100.90.56.120)

# 1. Clone repo
git clone <repo-url> ~/brainsait-superagent

# 2. Install Ollama + model
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:8b

# 3. Install Python deps
cd ~/brainsait-superagent
pip install -r requirements.txt

# 4. Configure
cp .env.example .env
# Edit: LARK_APP_ID, LARK_APP_SECRET, DSH_GATEWAY_KEY, NGC_API_KEY, BREV_TOKEN

# 5. Run
python -m brainsait.superagent --mode server
```

### 8.3 Services

| Service          | Type        | Port/Access            | Restart Policy |
|-----------------|-------------|------------------------|----------------|
| ollama          | systemd     | localhost:11434        | always         |
| brainsait-agent | systemd     | webhook listener       | always         |
| dsh-web         | systemd     | https://brainsait. ... | always         |

### 8.4 Monitoring

- **DSH Web Panel**: Router decisions, latency, cost, brain utilization, handoff chains
- **Knowledge Graph**: Entity/observation count over time
- **Lark Bot**: Message success/failure rate, user feedback signals
- **Systemd**: Service health, auto-restart on crash

---

*Document version: 1.0 — Draft specification for implementation.*
