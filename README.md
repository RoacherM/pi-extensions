# pi-extensions

Extensions for [Pi](https://pi.dev) (and [Epi](https://github.com/RoacherM/epi), which runs on Pi).
Each extension lives in its own folder under `extensions/`, is a self-contained Pi package, and is
**opt-in**: nothing here loads unless you install it.

| Extension | What it does | Needs | Docs |
|---|---|---|---|
| [layerfs](extensions/layerfs) | Runs the agent's file tools and shell commands in an isolated [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) branch; your folder changes only on `/layerfs apply`. Checkpoint per tool call, `/tree` / `/fork` restore files, multi-session safe | Docker + a local LayerFS build (one script) | [README](extensions/layerfs/README.md) · [Epi integration](extensions/layerfs/docs/EPI-INTEGRATION.md) |

## Install an extension

```bash
git clone https://github.com/RoacherM/pi-extensions.git
cd pi-extensions/extensions/<name>
# read its README for prerequisites, then:
pi install "$PWD"          # Pi, all projects
pi install -l "$PWD"       # Pi, current project only
epi install "$PWD"         # Epi, all projects (~/.epi/epi.json)
epi install -l "$PWD"      # Epi, current (trusted) project only
```

Try one without installing: `pi -e ./extensions/<name>`.

Remove: `pi remove <path>` / `epi remove <path>`.

## Conventions for extensions in this repo

1. **Opt-in.** An extension never enables itself; installing it is the only switch. It must
   document how to turn it off for one run and per machine.
2. **Fail closed, say why.** If a prerequisite is missing (Docker, a binary, a key), the
   extension reports it clearly and never silently changes behavior in a less safe way.
3. **Public Pi APIs only.** No imports of Pi internals, no dependency on Epi; Epi integration is
   documented per extension (`docs/EPI-INTEGRATION.md`) and goes through Pi's extension API.
4. **Host packages are peers.** `@earendil-works/pi-*` and `typebox` go in `peerDependencies`
   with `"*"`, never in `dependencies` (Pi package rules).
5. **A package per folder.** `package.json` with a `pi.extensions` entry and the `pi-package`
   keyword, a README with prerequisites / install / use / limits, a LICENSE, and tests.

## License

MIT, see [LICENSE](LICENSE). Individual extensions may include third-party code under their own
notices (see each extension's `NOTICE`).
