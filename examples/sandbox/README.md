# Sandbox

Everything `@bmfk/api` does, running on this machine, to try it by hand before a release.

```bash
npm run sandbox          # at the repository root: builds the UIs and the library, then starts
```

| What | Where |
|---|---|
| Start page: buttons for every call, a WebSocket tester | http://localhost:18900/api/demo/page |
| Monitor (2FA is set up at the first sign-in) | http://localhost:18900/api/sm/html — `admin` / `sandbox` |
| API documentation (2FA as well) | http://localhost:18900/api/doc/html — `doc` / `sandbox` |
| Ledger: a second service, a signed microservice host | http://localhost:18901/api |

- **Two processes.** The app calls the ledger with signed microservice calls; keys are made for each run.
  `pay` over 1000 is refused by the ledger, so you see an error coming back from another service.
- **Background traffic** every 3 s: valid and invalid requests, payments, a slow call, now and then a
  probe for the threat monitor. Charts and journals fill up without clicking.
- **Traces.** Every answer on the start page shows its trace id; find it in the monitor's journals, across
  both services.
- **Data** (2FA enrollment, metrics, threats) is in `examples/sandbox/.data`. Delete it to start over,
  for example to enroll 2FA again.

What to check before a release:

1. Monitor: sign in, enroll 2FA, sign out and in again; every tab shows data; trace links jump between
   journals; restart from the monitor.
2. API documentation: sign in, the `demo` group is listed with its models, the request builder calls work.
3. Start page: each button gives the answer it promises, the WebSocket echoes after `{"token":"sandbox"}`.
4. Logs (in this terminal): card data masked, a 400 is not logged as an error, `boom` logs one CRIT with
   its stack and answers the client with a bare 500.
