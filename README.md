# pi-skill-optimizer

**Keep your skill library. Cut the repeated context.**

![pi-skill-optimizer: a whole library, just the skills you need](assets/banner.png)

An extension for [Pi](https://github.com/earendil-works/pi) that makes room for your work by reducing repeated skill descriptions, tool definitions, and large results. Keep a growing library available without carrying all of it through every request.

Pi chooses what to use in the context of your task. The optimizer makes that choice easier to navigate and keeps the original instructions and results within reach.

## More capability, less repeated context

- **A library Pi can explore.** Optional setup turns skill descriptions into a compact topic directory and browsable cards. Pi can find a specialist, discover a supporting method, or load a known skill's full instructions and resources directly.
- **Tools that follow the work.** Tool definitions become available through search as the task develops. Core tools and tools already in use remain active within the host's permissions.
- **Shorter results with a way back.** Large output can be reduced with a link to its complete local original. Later exact duplicates can reuse that original, while the first result stays intact.
- **Progress you can see.** Search results have compact, expandable cards. Setup shows live progress, and status explains readiness, savings, provider usage, and the outcome of the last request.

## Install

Requires **Pi 1.0.1+** and **Node.js 26.3+**.

```bash
pi install npm:@aeondave/pi-skill-optimizer
```

Restart Pi, then check the optimizer's status:

```text
/skill-optimizer
```

The defaults work immediately. See [installation and updates](docs/CONFIGURATION.md#installation-and-updates) for other install options and upgrades.

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

Run init again to finish missing work or refresh changed skills. Your source skills stay unchanged. Everyday discovery runs locally without an embedding service or a separate ranking model; Pi's main model chooses what to load. Without init, Pi still gets a compact index of the available skills.

## Keep working as usual

Ask Pi to do your work. AUTO manages discovery and result size in the background, respects the host's selected skills and tools, and preserves instructions preloaded by pi-persona or another extension.

Use `/skill-optimizer` to see what is happening, or `/skill-optimizer audit` to find description issues in your library without rewriting it.

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
