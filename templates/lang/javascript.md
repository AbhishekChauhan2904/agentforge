## Language: JavaScript
- Match the project's module system (ESM or CommonJS) and use `const` by default and `===` always.
- Document exported functions with JSDoc types (`@param`, `@returns`) and add `// @ts-check` to files that handle auth, money or user input, so the editor catches type mistakes.
- There are no compile-time types, so validate all external data (request bodies, query params, env vars, API responses) at runtime with a schema library such as zod or joi.
- Do not convert files to TypeScript unless asked. If a change would clearly benefit from types, say so in your report instead.
- Run the linter and tests before finishing.
