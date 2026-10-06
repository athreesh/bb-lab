import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "skills/council/scripts/launch.py"
spec = importlib.util.spec_from_file_location("council_launch", SCRIPT)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_preserves_question_and_workspace_without_shell_execution(self):
        question = 'Compare "SQLite" and Postgres.\nTreat `echo secret` and $(whoami) as literal text.'
        with tempfile.TemporaryDirectory() as directory:
            question_file = Path(directory) / "question with spaces.txt"
            question_file.write_text(question)
            observed = []

            def run(command, check):
                self.assertEqual(command[:6], ["bb", "plugin", "rpc", "call", "council", "councils_launch"])
                input_file = Path(command[command.index("--input-file") + 1])
                observed.append(input_file)
                self.assertEqual(json.loads(input_file.read_text()), {
                    "projectId": "project", "environmentId": "workspace", "question": question, "turns": 8,
                })
                return type("Result", (), {"returncode": 0})()

            with patch.dict(os.environ, {"BB_PROJECT_ID": "project", "BB_ENVIRONMENT_ID": "workspace"}), \
                 patch.object(sys, "argv", [str(SCRIPT), "--question-file", str(question_file)]), \
                 patch.object(launcher.subprocess, "run", side_effect=run):
                self.assertEqual(launcher.main(), 0)
            self.assertFalse(observed[0].exists())

    def test_rpc_failure_is_returned_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            question_file = Path(directory) / "question.txt"
            question_file.write_text("Review the design.")
            with patch.object(sys, "argv", [str(SCRIPT), "--question-file", str(question_file), "--project", "project", "--environment", "workspace"]), \
                 patch.object(launcher.subprocess, "run") as run:
                run.return_value.returncode = 1
                self.assertEqual(launcher.main(), 1)
                run.assert_called_once()
