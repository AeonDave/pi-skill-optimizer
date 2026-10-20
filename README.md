# pi-skill-optimizer

**Keep your skill library. Cut the repeated context.**

![pi-skill-optimizer: a whole library, just the skills you need](assets/banner.png)

An extension for [Pi](https://github.com/earendil-works/pi) that helps large skill libraries and tool collections take up less room in each request. Discover skills on demand, bring in tool definitions as the task develops, and recover the full text behind shortened results.

Your library can keep growing without every skill description following every request. After optional setup, Pi explores a compact directory of topics, browses short skill cards, and loads the instructions it chooses in full. The main model makes those choices in the context of your work, including supporting methods such as architecture, testing, and verification.

## Install

Requires **Pi 1.0.0+** and **Node.js 26.3+**.

```bash
pi install npm:@aeondave/pi-skill-optimizer
```

Restart Pi, then check the optimizer's status:

```text
/skill-optimizer
```

The defaults work immediately. See [installation and updates](docs/CONFIGURATION.md#installation-and-updates) for project-local installs, version pinning, and migration from the old unscoped package.

## Give Pi a map of your library

Run the optional setup to organize your installed skills into browsable topics:

```text
/skill-optimizer init
```

**Init uses your current Pi model and may incur provider cost.** A panel above the editor shows saved progress, the current batch and model, elapsed time, and provider activity while it works.

Completed batches are saved as they finish. You can stop with:

```text
/skill-optimizer cancel
```

Run init again to finish missing work or refresh changed skills. Your source skills stay unchanged, and discovery needs no embedding service or separate ranking model. Without init, Pi still gets a compact index of the available skills.

## Keep working as usual

Ask Pi to do your work. AUTO manages discovery and result size in the background:

- **Skills stay within reach.** Pi can browse the library or load a known skill directly, including full instructions and associated resources.
- **Tools arrive as needed.** Less relevant definitions sit behind search, while core tools and tools already used in the session stay active within the host's permissions.
- **Large results remain recoverable.** Shortened output points back to a complete local original that Pi can retrieve. The first large result stays intact when later exact copies are deduplicated.

Use `/skill-optimizer` to inspect setup readiness, savings, active tools, and provider usage. Use `/skill-optimizer audit` to find description issues in your library without rewriting it.

Start with the defaults; [configuration](docs/CONFIGURATION.md) covers project preferences, output modes, RTK coexistence, and persona restrictions.

## Understand the trade-offs

On-demand discovery trades repeated context for occasional browsing turns. The benefit depends on your library and how Pi uses it; [benchmarks and evaluation limits](BENCHMARK.md) give measured examples and explain their scope.

Reduced results keep their originals in local archives for seven days by default. Normal hooks do not collect a benchmark corpus. See [privacy and persistence](docs/CONFIGURATION.md#telemetry-and-persistence) before changing retention or running an explicit remote evaluation.

## Explore further

- [Configuration and command reference](docs/CONFIGURATION.md) — setup, controls, and everyday troubleshooting.
- [How AUTO works](docs/ARCHITECTURE.md) — discovery, dynamic tools, output recovery, and guarantees.
- [Ranking decisions](docs/RANKING.md) — selection behavior and relevance limits.
- [Benchmark protocol](BENCHMARK.md) — measurements, local validation, and private evaluation workflows.
- [Changelog](CHANGELOG.md) — release history.

MIT. See [LICENSE](LICENSE).
