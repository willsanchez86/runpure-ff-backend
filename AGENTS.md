# Rules for agents in this repo

1. Build only what a PRD and spec on `runpure-ff-planning` `main` describe. Never copy planning documents here; link to them.
2. Every pull request fills in `Implements:` with the PRD, spec and ADR paths it carries out.
3. Before an ADR's first implementing code merges, its planning-repo file must have an **Implementation started** line.
4. Never commit with `--no-verify`. Never push to `main`; open a pull request.
5. Comments: a JSDoc comment on every exported function, type and constant (what it does, plus any constraint a caller must know); one header comment per module naming the spec section or ADR it implements; inline comments only for why, never for what the code plainly does. `npm run lint` checks the JSDoc.
