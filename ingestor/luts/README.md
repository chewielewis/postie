# LUTs

Drop the show's `.cube` conversion LUTs here. They are git-ignored (licensed,
not for redistribution). The log-format preset chosen at session setup maps to
a filename:

| Preset  | Filename               | Use                       |
|---------|------------------------|---------------------------|
| `slog3` | `slog3_to_709.cube`    | Sony FX6 / FX30 / A7S III |
| `slog2` | `slog2_to_709.cube`    | Older Sony S-Log2         |
| `dlogm` | `dlog_m_to_709.cube`   | DJI D-Log M               |
| `none`  | _(no LUT)_             | Footage already Rec.709   |

If a preset is selected but its `.cube` is missing, the ingest fails fast with
a clear error naming the expected path.
