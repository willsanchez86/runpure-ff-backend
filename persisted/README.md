# Trusted documents (ADR-0016 item 3, ADR-0017 item 9)

The GraphQL endpoint runs only operations listed here, looked up by the hash the client
sends (`extensions.persistedQuery.sha256Hash`, Apollo's APQ format).

- `frontend.json`: the web app's operations, `{ "<hash>": "<document>" }`, written by the
  frontend's GraphQL Code Generator run and copied here in the same change set as the
  frontend code that uses them. Deploy the backend first.
- `operator/*.graphql`: operator operations owned by this repo. Each file's SHA-256
  hash is its key; the server prints the hashes at startup.
