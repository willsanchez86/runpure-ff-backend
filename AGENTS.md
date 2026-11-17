# Rules for agents in this repo

1. Build only what a PRD and spec on `runpure-ff-planning` `main` describe. Never copy planning documents here; link to them.
2. Every pull request fills in `Implements:` with the PRD, spec and ADR paths it carries out.
3. Before an ADR's first implementing code merges, its planning-repo file must have an **Implementation started** line.
4. Never commit with `--no-verify`. Never push to `main`; open a pull request.
5. Comments (owner, 2026-11-17): a JSDoc comment on every exported function, type and constant (what it does, plus any constraint a caller must know); one header comment per module naming the spec section or ADR it implements; short inline comments describing the logic throughout — clear and concise, never excessive. `npm run lint` checks the JSDoc.
6. Names and conditionals (owner, 2026-11-17): descriptive identifiers — no single-letter variables, parameters or properties (exceptions: `_`-prefixed deliberate discards; the DOM's own attribute names). Explain an abbreviated or non-obvious name once, where it is declared; prefer a rename over a comment. Guard clauses (early returns) are the preferred conditional style.
