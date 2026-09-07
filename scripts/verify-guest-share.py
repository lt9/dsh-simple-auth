#!/usr/bin/env python3
"""Verify guest can read session-acl and open shared session RPCs."""
import json
import urllib.parse
import urllib.request
import http.cookiejar

LOCAL = "http://127.0.0.1:13080"
SHARED = "session-d3df8b40-25db-4521-99ac-0bd7f0124928"


def login(key: str):
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    data = urllib.parse.urlencode({"key": key, "next": "/"}).encode()
    opener.open(urllib.request.Request(LOCAL + "/login", data=data, method="POST"), timeout=20)
    return opener


def main():
    guest_key = open("/home/twan/llama/auth-extra-keys").read().strip().splitlines()[0]
    op = login(guest_key)

    req = urllib.request.Request(LOCAL + "/simple-auth/session-acl?sessionId=" + urllib.parse.quote(SHARED))
    with op.open(req, timeout=20) as r:
        acl = {"status": r.status, "body": json.loads(r.read().decode())}

    def rpc(method, payload):
        body = json.dumps(
            {"type": "client-request", "method": method, "rpcId": "v1", "payload": payload}
        ).encode()
        req = urllib.request.Request(
            LOCAL + "/api/" + method,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with op.open(req, timeout=60) as r:
                return {"status": r.status, "body": json.loads(r.read().decode())}
        except urllib.error.HTTPError as ex:
            return {"status": ex.code, "error": ex.reason}

    hist = rpc("session.history", {"sessionId": SHARED, "maxMessages": 1})

    ok = (
        acl["status"] == 200
        and acl["body"].get("canShare") is False
        and hist.get("body", {}).get("result", {}).get("ok") is True
    )
    print(
        json.dumps(
            {
                "ok": ok,
                "session-acl": acl,
                "session.history": hist,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
