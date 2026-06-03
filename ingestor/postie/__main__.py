"""Entry point:  python -m postie --show PGHI [--port 4321]"""

import argparse
import sys

from . import __version__


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="postie", description="Postie Ingestor — camera-card ingest for Avid/Resolve")
    parser.add_argument("--show", required=True, help="Show code, e.g. PGHI")
    parser.add_argument("--port", type=int, default=4321, help="UI port (default 4321)")
    parser.add_argument("--version", action="version", version="postie-ingestor " + __version__)
    args = parser.parse_args(argv)

    from .server import Server  # deferred so --version/--help don't touch Supabase
    Server(args.show.upper(), args.port).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
