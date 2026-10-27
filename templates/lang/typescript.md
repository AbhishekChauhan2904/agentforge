## Language: TypeScript
- Keep `"strict": true` in tsconfig. Never use `any`: use `unknown` and narrow it. No `@ts-ignore`; if you must suppress, use `@ts-expect-error` with a reason.
- Types disappear at runtime, so validate all external data (request bodies, query params, env vars, API responses) with a schema library such as zod, and derive types with `z.infer`.
- Use `import type` for type-only imports; export shared types from one place; type function return values on public APIs.
- Avoid non-null assertions (`!`) and unchecked casts (`as X`); prefer type guards.
- Run `npx tsc --noEmit` before finishing. It is part of the quality gate.
