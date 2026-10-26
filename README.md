# DebtKiller 💪

A tiny, fun daily tracker for paying off debts by a deadline.

- No dependencies, plain Node (`npm start`).
- Debt data is **not** in this repo. It comes from the `DEBT_DATA` env var (base64-encoded gzip JSON).
- Progress is saved to `$DATA_DIR/state.json` (defaults to `/data` if a volume is mounted there).
- Protected by a 6-digit `PIN` env var.

## Env vars
| Var | What |
|---|---|
| `PIN` | 6-digit PIN to open the app |
| `SECRET` | random string for signing the login cookie |
| `DEBT_DATA` | base64(gzip(JSON)) with `{ enemies, plan, total }` |
| `DATA_DIR` | optional, where `state.json` is stored (default `/data`) |
