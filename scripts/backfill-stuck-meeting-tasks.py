#!/usr/bin/env python3
"""
One-shot backfill: find open [Meeting] Jira tasks across CER/EOS/WMS,
match them against succeeded runner jobs (by meetingId in source + action text),
and transition the matched ones to Done.

Unmatched tasks are listed at the end for human review (per Mark's instruction:
"Anything with no matching job → close as 'Won't Do' or leave for you").

Usage: python3 backfill-stuck-meeting-tasks.py [--dry-run]
"""
import os, sys, json, re, base64, urllib.request, urllib.parse, urllib.error
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv

# Load .env
ENV = {}
env_path = Path(__file__).resolve().parents[1] / ".env"
for line in env_path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    ENV[k.strip()] = v.strip().strip('"').strip("'")

JIRA_DOMAIN = ENV["JIRA_DOMAIN"].rstrip("/")
JIRA_EMAIL = ENV["JIRA_EMAIL"]
JIRA_TOKEN = ENV["JIRA_API_TOKEN"]
AUTH = "Basic " + base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()

PROJECTS = ["CER", "EOS", "WMS"]

def jira_get(path):
    req = urllib.request.Request(f"{JIRA_DOMAIN}{path}", headers={"Authorization": AUTH, "Accept": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def jira_post(path, body):
    req = urllib.request.Request(
        f"{JIRA_DOMAIN}{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": AUTH, "Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    res = urllib.request.urlopen(req, timeout=30)
    return res.status

def jira_post_search(body):
    req = urllib.request.Request(
        f"{JIRA_DOMAIN}/rest/api/3/search/jql",
        data=json.dumps(body).encode(),
        headers={"Authorization": AUTH, "Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def find_open_meeting_tasks():
    issues = []
    for proj in PROJECTS:
        jql = f'project = {proj} AND summary ~ "Meeting" AND statusCategory != Done'
        next_token = None
        for _ in range(20):
            body = {"jql": jql, "fields": ["summary", "status", "labels"], "maxResults": 100}
            if next_token:
                body["nextPageToken"] = next_token
            data = jira_post_search(body)
            for it in data.get("issues", []):
                summary = it["fields"]["summary"]
                if not summary.startswith("[Meeting]"):
                    continue
                issues.append({
                    "key": it["key"],
                    "summary": summary,
                    "status": it["fields"]["status"]["name"],
                    "labels": it["fields"].get("labels", []),
                    "project": proj,
                })
            next_token = data.get("nextPageToken")
            if not next_token or data.get("isLast", True):
                break
    return issues

def load_runner_jobs():
    """Pull all succeeded meeting-sourced jobs from the runner Postgres DB.
    Includes orphans (no meeting_action stored) — recovers task text from prompt."""
    import subprocess
    sql = (
        "SELECT job_id, agent, COALESCE(issue_key,''), status, source, "
        "COALESCE(prompt,''), COALESCE(meeting_action::text,'') "
        "FROM jobs WHERE status='succeeded' AND source LIKE 'meeting:%';"
    )
    out = subprocess.check_output(
        [
            "docker", "exec",
            "-e", "PGPASSWORD=runner_secure_password",
            "orchestracode-postgres",
            "psql", "-U", "runner", "-d", "runner",
            "-tA", "-F", "\x1f", "-c", sql,
        ],
        timeout=30,
    ).decode()
    jobs = []
    task_pat = re.compile(r"\*\*Task:\*\*\s*([^\r\n]{1,400})")
    # Postgres -tA escapes newlines as \n inside fields; replace before splitting rows.
    # Use NUL as field separator instead — but psql doesn't support that, so use \x1f.
    # Each row is terminated by a real newline. Multi-line prompts will trip splitlines();
    # rejoin lines until we have 7 fields.
    buf = []
    for line in out.split("\n"):
        buf.append(line)
        candidate = "\n".join(buf)
        if candidate.count("\x1f") >= 6:
            parts = candidate.split("\x1f", 6)
            buf = []
            if len(parts) < 7:
                continue
            job_id, agent, issue_key, status, source, prompt, ma_raw = parts
            ma = None
            if ma_raw:
                try:
                    ma = json.loads(ma_raw)
                except Exception:
                    ma = None
            task = (ma or {}).get("task")
            if not task:
                m = task_pat.search(prompt)
                if m:
                    task = m.group(1).strip()
            if not task:
                continue
            meeting_id = source.split(":", 1)[1] if ":" in source else None
            jobs.append({
                "jobId": job_id,
                "agent": agent,
                "issueKey": issue_key or None,
                "status": status,
                "source": source,
                "meetingId": meeting_id,
                "task": task.strip(),
            })
    return {"jobs": jobs}

def normalise(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower())).strip()

def task_matches(jira_summary, job_task):
    """Match Jira summary to job's meetingAction.task text."""
    js = normalise(jira_summary).replace("meeting", "", 1).strip()
    jt = normalise(job_task)
    if not js or not jt:
        return False
    if js == jt:
        return True
    if js in jt or jt in js:
        return True
    js_words = set(w for w in js.split() if len(w) > 3)
    jt_words = set(w for w in jt.split() if len(w) > 3)
    if not js_words:
        return False
    overlap = len(js_words & jt_words) / len(js_words)
    return overlap >= 0.7

def transition_to_done(issue_key, comment):
    trans = jira_get(f"/rest/api/3/issue/{issue_key}/transitions")["transitions"]
    done = next((t for t in trans if t["name"].lower() == "done"), None)
    if not done:
        return False, "no Done transition"
    if DRY_RUN:
        return True, f"[dry-run] would transition via {done['id']}"
    # Add comment first
    try:
        jira_post(f"/rest/api/3/issue/{issue_key}/comment", {
            "body": {"type": "doc", "version": 1, "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": comment}]}
            ]}
        })
    except Exception as e:
        print(f"  comment failed: {e}")
    code = jira_post(f"/rest/api/3/issue/{issue_key}/transitions", {"transition": {"id": done["id"]}})
    return code in (200, 204), f"transition status {code}"

def main():
    print(f"[backfill] DRY_RUN={DRY_RUN}")
    issues = find_open_meeting_tasks()
    print(f"[backfill] {len(issues)} open [Meeting] tasks across {PROJECTS}")
    state = load_runner_jobs()
    succeeded = state["jobs"]
    print(f"[backfill] {len(succeeded)} succeeded meeting-sourced jobs in runner DB")

    closed = []
    unmatched = []
    for it in issues:
        # Try direct issueKey match first (jobs created via dispatchMeetingActions stamp issueKey)
        direct = [j for j in succeeded if j.get("issueKey") == it["key"]]
        candidate = None
        if direct:
            candidate = direct[0]
        else:
            # Fall back to task-text matching across all meeting jobs
            for j in succeeded:
                if task_matches(it["summary"], j["task"]):
                    candidate = j
                    break
        if not candidate:
            unmatched.append(it)
            continue
        comment = (
            f"Backfill closure — succeeded job {candidate['jobId']} "
            f"(agent {candidate.get('agent','?')}, meeting {candidate.get('meetingId','?')}). "
            f"Auto-closure was missed before the scheduler bug was patched."
        )
        ok, msg = transition_to_done(it["key"], comment)
        if ok:
            closed.append((it["key"], candidate["jobId"], msg))
            print(f"  [OK] {it['key']:12s} <- {candidate['jobId']}  ({msg})")
        else:
            print(f"  [FAIL] {it['key']:12s} ({msg})")

    print()
    print(f"=== closed: {len(closed)} ===")
    for k, jid, msg in closed:
        print(f"  {k}  job={jid}  {msg}")
    print()
    print(f"=== unmatched (left for human review): {len(unmatched)} ===")
    for it in unmatched:
        print(f"  {it['key']:12s} [{it['status']}] {it['summary'][:90]}")

if __name__ == "__main__":
    main()
