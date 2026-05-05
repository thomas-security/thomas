# thomas SDK

Public TypeScript surface for code that targets thomas's agent (L1) and
translator (L2) layers. In v0.x this is purely an in-repo organisational
boundary — every type re-exported here lives in its canonical module
elsewhere in `src/`. The point of the SDK directory is to:

1. Give plugin / adapter authors **one stable import path** that doesn't
   change as we move files around in `src/`.
2. Define **`TranslatorPair`** (in `translator.ts`) — the only L2 contract
   that wasn't previously named as a TypeScript interface. Existing
   translators in `src/proxy/translate/` already match it; the type here
   just documents the shape.
3. Pre-stage the SDK to be carved out as `@thomas/sdk` (a thin published
   package) when a plugin runtime arrives.

## What's here

| File | Re-exports from | Notes |
|---|---|---|
| `agent.ts` | `src/agents/types.ts` | `AgentSpec`, `DetectResult`, `ShimContext`, `AgentSnapshot`, etc. |
| `credential.ts` | `src/config/credentials.ts` | `Credential`, `SecretRef` |
| `provider.ts` | `src/providers/registry.ts` | `ProviderSpec` |
| `protocols.ts` | `src/proxy/translate/types.ts` | `AnthropicRequest`, `OpenAIRequest`, message + content shapes |
| `translator.ts` | (new) | `TranslatorPair`, `StreamTranslator`, `StreamTranslatorCtor` |
| `index.ts` | barrel | `import { … } from "src/sdk"` |

## Stability

These types are **stable across thomas patch + minor releases**. Breaking
changes go in major releases and ship with a migration note in
`CHANGELOG.md`. See the upcoming auto-update + plugin design docs in
`thomas-cloud` for the cross-process compatibility guarantees.

## Contributor guidance

- New L1 adapter: implement `AgentSpec` from `./agent.js`. Register in
  `src/agents/registry.ts`. Tests in `tests/<id>.test.ts`.
- New L2 translator pair: write a module exporting
  `translateRequest`, `translateResponseBody`, and a `StreamTranslator`
  class. Match `TranslatorPair` from `./translator.js`. Wire into
  `src/proxy/server.ts`'s direction selector.

Both layers are deliberately small contracts. Don't add abstractions
here without a concrete second consumer that needs them.
