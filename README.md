# TrustedExec-Bench

**Scenario-grounded security evaluation for autonomous personal AI assistants.**

**Built by OpenGuardrails — https://openguardrails.com**

TrustedExec-Bench measures **trusted execution**: whether an autonomous agent can complete useful work **without crossing user intent, authority boundaries, or safety limits**.

It is built for agent systems such as **OpenClaw**, **Hermes Agent**, and other autonomous harnesses running different model combinations.

---

## Why this exists

Personal AI assistants can now:

- read and send email
- manage calendars and contacts
- organize local files
- analyze financial documents
- control home and security devices
- execute scripts and multi-step workflows

That means the main question is no longer just:

> **Can the agent do the task?**

It is:

> **Can the agent be trusted to do the task safely?**

A capable agent is still unsafe if it:

- deletes the whole inbox instead of a few emails
- sends the wrong message to the wrong person
- leaks sensitive local files
- unlocks a door without proper confirmation
- runs destructive commands from vague instructions

TrustedExec-Bench is designed to measure exactly this.

---

## What makes this benchmark different

Most existing benchmarks focus on one of two things:

- **capability** — can the agent finish the task?
- **adversarial robustness** — can the agent resist prompt injection?

TrustedExec-Bench focuses on a different problem:

## **trusted execution under autonomy**

We evaluate whether an agent preserves:

- **user intent**
- **authorization**
- **object-level correctness**
- **least-privilege execution**
- **safe handling of ambiguity**
- **recoverability after mistakes**

This is an **agent benchmark**, not a model-only benchmark.

The evaluation target is the full stack:

- **model**
- **agent harness**
- **skills / tools**
- **permission profile**
- **runtime behavior**

---

## Initial suite: Personal AI Assistant

The first release focuses on the **personal AI assistant** setting.

### Scenario areas

- **Communication & Coordination**  
  email, calendar, contacts, messaging

- **Files & Personal Knowledge**  
  local files, cloud files, notes, documents

- **Personal Finance Analysis**  
  earnings reports, portfolio docs, financial summaries

- **Financial Execution**  
  subscriptions, transfers, trades, account actions

- **Home & Physical Security**  
  cameras, locks, alarms, automations

- **Local System & Automation**  
  scripts, desktop workflows, shell actions, cleanup tasks

---

## What we test

TrustedExec-Bench includes both:

- **benign but ambiguous tasks**
- **adversarially manipulated tasks**

Attack and failure sources include:

- malicious email or document content
- malicious web content
- malicious or misleading skill behavior
- poisoned or stale memory
- vague instructions
- wrong-object traps
- duplicated names and conflicting context
- high-consequence actions without confirmation

Many real failures do **not** require an explicit jailbreak.  
This benchmark is designed around that reality.

---

## Core metrics

- **Safe Completion Rate (SCR)**  
  completed successfully, with no unsafe side effects

- **Task Success Rate (TSR)**  
  completed successfully, regardless of safety

- **Boundary Violation Rate (BVR)**  
  crossed scope, authorization, or object boundaries

- **Irreversible Action Rate (IAR)**  
  performed destructive or high-consequence actions unsafely

- **Blast Radius Score (BRS)**  
  how much user state was affected by a failure

- **Clarification Correctness (CC)**  
  asked, abstained, or narrowed scope when appropriate

- **Recovery Score (RS)**  
  contained, rolled back, or safely degraded after error

---

## Example failures

- archive 3 emails → deletes the entire inbox
- summarize one folder → scans the whole drive
- draft a reply → sends the message
- check a camera alert → disables the alarm
- clean up downloads → removes important documents
- review an earnings report → follows malicious embedded instructions

---

## Quickstart

> Placeholder commands for the first public release.

### Install

```bash id="jov66"
git clone https://github.com/openguardrails/trustedexec-bench.git
cd trustedexec-bench
pip install -e .
````

### Run an evaluation

```bash id="sr34c"
trustedexec eval \
  --agent openclaw \
  --model <model_name> \
  --suite personal_assistant \
  --output results/run.json
```

### Compare runs

```bash id="g6sk6"
trustedexec compare \
  --runs results/run_a.json results/run_b.json
```

---

## What gets benchmarked

Each run is defined by:

* **agent harness**
* **model**
* **skill / tool pack**
* **permission profile**
* **scenario suite**

That means TrustedExec-Bench can compare:

* OpenClaw vs Hermes Agent
* one model vs another
* the same harness with different skill packs
* the same stack under different permission settings

---

## Roadmap

### v0.1

* Personal AI Assistant suite
* core scenarios across email, files, finance, home security, and local system
* OpenClaw and Hermes adapters
* baseline metrics and result schema

### v0.2

* skill-aware attack suite
* richer permission profiles
* stronger recovery and rollback scoring

### v0.3

* Enterprise Autonomous Agent suite
* delegated authority and approval-chain scenarios
* multi-agent and cross-system workflows

---

## Contributing

We welcome contributions in:

* new scenarios
* new attack patterns
* new agent adapters
* new evaluators and metrics

Please open an issue before large changes.

---

## Status

TrustedExec-Bench is under active development.

The first public release focuses on:

> **trusted execution for autonomous personal AI assistants**

## About

TrustedExec-Bench is created and maintained by **OpenGuardrails**.

OpenGuardrails builds the **trust layer for the agentic world**, protecting every agent execution.

Learn more: https://openguardrails.com
