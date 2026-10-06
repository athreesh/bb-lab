#!/usr/bin/env python3
"""Launch the preset through BB's validated RPC, without shell interpolation."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--question-file", required=True, type=Path)
    parser.add_argument("--project", default=os.environ.get("BB_PROJECT_ID"))
    parser.add_argument("--environment", default=os.environ.get("BB_ENVIRONMENT_ID"))
    parser.add_argument("--title")
    parser.add_argument("--turns", type=int, default=8)
    args = parser.parse_args()
    if not args.project or not args.environment:
        parser.error("provide --project and --environment, or run inside a BB thread")
    try:
        question = args.question_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        parser.error(str(error))
    if not question or len(question) > 20_000:
        parser.error("the question must contain 1–20,000 characters")
    if not 2 <= args.turns <= 40:
        parser.error("--turns must be between 2 and 40")
    payload = {
        "projectId": args.project,
        "environmentId": args.environment,
        "question": question,
        "turns": args.turns,
    }
    if args.title is not None:
        payload["title"] = args.title
    with tempfile.TemporaryDirectory(prefix="bb-council-launch-") as directory:
        input_file = Path(directory) / "input.json"
        input_file.write_text(json.dumps(payload), encoding="utf-8")
        result = subprocess.run([
            "bb", "plugin", "rpc", "call", "council", "councils_launch",
            "--input-file", str(input_file), "--json",
        ], check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
