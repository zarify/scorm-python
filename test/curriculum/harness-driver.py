"""Line-oriented adapter for the persistent curriculum harness process."""

import json
import os
import sys
import tempfile

repo_root = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
sys.path.insert(0, os.path.join(repo_root, "src", "shared", "python"))
sys.path.insert(0, "")  # Resolve seeded student modules from each harness workspace.
os.environ.setdefault(
    "SCORM_HARNESS_WORKDIR", tempfile.mkdtemp(prefix="curriculum-work-")
)

import harness  # noqa: E402

# Student stdout is streamed by harness.run() to its original stdout. Keep that
# stream off the JSON protocol channel while retaining transcripts internally.
protocol_stdout = sys.stdout
sys.stdout = sys.stderr

OPERATIONS = {
    "run": harness.run,
    "analyze": harness.analyze,
    "validate_patterns": harness.validate_patterns,
}

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        operation = OPERATIONS[request["op"]]
        spec = json.dumps(request.get("spec", {}), ensure_ascii=False)
        result = json.loads(operation(spec))
        response = {"id": request["id"], "result": result}
    except Exception as exc:
        response = {
            "id": request.get("id") if isinstance(request, dict) else None,
            "error": f"{type(exc).__name__}: {exc}",
        }
    protocol_stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    protocol_stdout.flush()
