"""Choose what this lifecycle run works on.

An explicit target wins unchanged. With none, this is the factory's backlog
intake: the oldest open issue in the origin repository that no earlier run has
touched — no `archon-*` state label (triage publishes one when the caller sets
publish=true) and no open pull request that names it. Nothing found completes
the run with nothing to do, which is a fact, not a failure. Deterministic gh
reads only; the judgment about the issue belongs to triage.
"""

import json
import os
import re
import subprocess
import sys
from urllib.parse import urlencode, urlsplit


def gh(*args: str):
    out = subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def origin_repo() -> str:
    remote = subprocess.run(["git", "remote", "get-url", "origin"],
                            check=True, capture_output=True, text=True).stdout.strip()
    if remote.startswith("git@github.com:"):
        remote = "https://github.com/" + remote[len("git@github.com:"):]
    url = urlsplit(remote)
    path = url.path.strip("/").removesuffix(".git")
    parts = path.split("/")
    if (url.hostname != "github.com" or url.scheme not in ("https", "ssh")
            or url.query or url.fragment or url.port is not None
            or len(parts) != 2 or any(not part or part in (".", "..") for part in parts)
            or any(not (c.isalnum() or c in "-_./") for c in path)):
        raise ValueError("origin is not a supported GitHub repository")
    return path


def open_items(repo: str, resource: str, label: str = "") -> list:
    params = {"state": "open", "per_page": "100"}
    if label:
        params["labels"] = label
    pages = gh("api", "--hostname", "github.com",
               f"repos/{repo}/{resource}?{urlencode(params)}", "--paginate", "--slurp")
    return [item for page in pages for item in page]


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    explicit = os.environ.get("INPUTS_TARGET", "").strip()
    if explicit:
        print(json.dumps({"target": explicit, "found": True, "selected": False, "reason": "explicit target"}))
        return 0
    label = os.environ.get("INPUTS_INTAKE_LABEL", "")
    repo = origin_repo()
    issues = [issue for issue in open_items(repo, "issues", label) if "pull_request" not in issue]
    prs = open_items(repo, "pulls")
    referenced = set()
    for pr in prs:
        for match in re.findall(r"#(\d+)", f"{pr.get('title', '')}\n{pr.get('body', '')}"):
            referenced.add(int(match))
    candidates = []
    for issue in issues:
        labels = {label.get("name", "") for label in issue.get("labels", [])}
        if label and label not in labels:
            continue
        if any(name.startswith("archon-") for name in labels):
            continue
        if issue["number"] in referenced:
            continue
        candidates.append(issue)
    if not candidates:
        print(json.dumps({"target": "", "found": False, "selected": True,
                          "reason": f"{len(issues)} open issue(s), none untouched"}))
        return 0
    chosen = min(candidates, key=lambda issue: issue["number"])
    print(json.dumps({"target": chosen["html_url"], "found": True, "selected": True,
                      "reason": f"oldest untouched open issue of {len(candidates)}"}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"select-target: {error}", file=sys.stderr)
        sys.exit(1)
