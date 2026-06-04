"""Entry point:  python -m postie --show PGHI [--port 4321]"""

import argparse
import sys

from . import __version__


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="postie", description="Postie Ingestor — camera-card ingest for Avid/Resolve")
    parser.add_argument("--show", required=True, help="Show code, e.g. PGHI")
    parser.add_argument("--port", type=int, default=4321, help="UI port (default 4321)")
    parser.add_argument("--status", action="store_true",
                        help="Print ingest progress from Supabase and exit")
    parser.add_argument("--watch", action="store_true",
                        help="With --status, refresh live until Ctrl+C")
    parser.add_argument("--interval", type=float, default=4.0,
                        help="Seconds between --watch refreshes (default 4)")
    parser.add_argument("--version", action="version", version="postie-ingestor " + __version__)
    args = parser.parse_args(argv)

    if args.status:
        from .status import run  # deferred so --version/--help don't touch Supabase
        run(args.show.upper(), watch=args.watch, interval=args.interval)
        return 0

    from .server import Server
    Server(args.show.upper(), args.port).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
