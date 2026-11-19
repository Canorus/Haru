#!/usr/bin/env python3
"""Haru CLI — no third-party packages required."""
import argparse
import getpass
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

BASE = os.environ.get("HARU_URL", "http://127.0.0.1:3000/haru").rstrip("/")
USERNAME = os.environ.get("HARU_USERNAME", "admin")
PASSWORD = os.environ.get("HARU_PASSWORD")
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


class ApiError(Exception):
    def __init__(self, data, status):
        super().__init__(data.get("error") or data.get("code") or f"HTTP {status}")
        self.data = data
        self.status = status


def request(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with opener.open(req) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            response = json.load(error)
        except (ValueError, TypeError):
            response = {"error": error.reason}
        raise ApiError(response, error.code) from error


def login():
    password = PASSWORD or getpass.getpass(f"{USERNAME} 관리자 비밀번호: ")
    request("/api/login", "POST", {"username": USERNAME, "password": password})


def resolve_due(value):
    if not value or value == "none":
        return None
    if value == "today":
        return date.today().isoformat()
    if value == "tomorrow":
        return (date.today() + timedelta(days=1)).isoformat()
    try:
        datetime.fromisoformat(value)
        return value
    except ValueError as error:
        raise SystemExit("기한은 today, tomorrow, none, YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM 형식이어야 합니다.") from error


def resolve_recurrence(value):
    if not value or value == "none":
        return {"type": "none"}
    if value in ("hourly", "daily"):
        return {"type": value}
    try:
        if value.startswith("weekly:"):
            weekday = int(value.split(":", 1)[1])
            if 0 <= weekday <= 6:
                return {"type": "weekly", "weekday": weekday}
        if value.startswith("monthly:"):
            day = int(value.split(":", 1)[1])
            if 1 <= day <= 31:
                return {"type": "monthly", "day": day}
        if value.startswith("yearly:"):
            month, day = map(int, value.split(":", 1)[1].split("-", 1))
            if 1 <= month <= 12 and 1 <= day <= 31:
                return {"type": "yearly", "month": month, "day": day}
    except ValueError:
        pass
    raise SystemExit("반복은 none, hourly, daily, weekly:0-6, monthly:1-31 또는 yearly:MM-DD 형식이어야 합니다.")


def main():
    parser = argparse.ArgumentParser(prog="haru", description="Haru 태스크 CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="태스크 추가")
    add.add_argument("title", help="설정된 리스트·우선도·태그 마커와 자연어 기한을 포함할 수 있습니다")
    add.add_argument("-l", "--list", dest="list_name", help="리스트 이름")
    add.add_argument("-d", "--due", help="today, tomorrow, none 또는 YYYY-MM-DD")
    add.add_argument("-p", "--priority", choices=["none", "low", "medium", "high"])
    add.add_argument("--repeat", default="none", help="hourly, daily, weekly:요일(0-6), monthly:일, yearly:MM-DD")
    show = sub.add_parser("list", help="태스크 목록")
    show.add_argument("-l", "--list", dest="list_name")
    show.add_argument("-d", "--due")
    show.add_argument("-p", "--priority", choices=["none", "low", "medium", "high"])
    done = sub.add_parser("done", help="태스크 완료")
    done.add_argument("task_id")
    create = sub.add_parser("create", help="새 사용자 생성 (관리자 인증 필요)")
    create.add_argument("username")
    create.add_argument("password", nargs="?", help="생략하면 임시 비밀번호 자동 생성")
    create.add_argument("-r", "--role", choices=["admin", "user", "guest"], default="user")
    args = parser.parse_args()
    login()
    if args.command == "create":
        payload = {"username": args.username, "role": args.role}
        if args.password:
            payload["password"] = args.password
        result = request("/api/users", "POST", payload)
        created = result["user"]
        print(f"사용자 생성됨  {created['address']}")
        print(f"임시 비밀번호  {result['temporaryPassword']}")
        print("첫 로그인 후 비밀번호를 변경해야 합니다.")
        return
    snapshot = request("/api/bootstrap")
    lists = {item["name"].lower(): item for item in snapshot["lists"]}

    if args.command == "add":
        selected = lists.get(args.list_name.lower()) if args.list_name else None
        if args.list_name and not selected:
            answer = input(f"'{args.list_name}' 리스트가 없습니다. 만들까요? [y/N] ")
            if answer.lower() not in ("y", "yes"):
                raise SystemExit("취소했습니다.")
            selected = request("/api/lists", "POST", {"name": args.list_name})["list"]
        payload = {"title": args.title, "due": resolve_due(args.due),
                   "priority": args.priority or "none", "recurrence": resolve_recurrence(args.repeat)}
        if selected:
            payload["listId"] = selected["id"]
        while True:
            try:
                task = request("/api/tasks", "POST", payload)["task"]
                break
            except ApiError as error:
                if error.data.get("code") == "LIST_NOT_FOUND":
                    name = error.data["listName"]
                    answer = input(f"'{name}' 리스트가 없습니다. 만들까요? [y/N] ")
                    if answer.lower() not in ("y", "yes"):
                        raise SystemExit("취소했습니다.")
                    payload["listId"] = request("/api/lists", "POST", {"name": name})["list"]["id"]
                    continue
                if error.data.get("code") == "DUE_CONFIRM_REQUIRED":
                    phrase = error.data["phrase"]
                    suggested = error.data["suggestedDue"]
                    answer = input(f"'{phrase}'를 {suggested} 기한으로 적용할까요? [y/N] ")
                    payload["dueDecision"] = "accept" if answer.lower() in ("y", "yes") else "keep"
                    continue
                raise
        print(f"추가됨  {task['id']}  {task['title']}")
        if task.get("tags"):
            print("태그    " + " ".join(f"#{tag}" for tag in task["tags"]))
    elif args.command == "list":
        selected = lists.get(args.list_name.lower()) if args.list_name else None
        tasks = snapshot["tasks"]
        if selected:
            tasks = [task for task in tasks if task["listId"] == selected["id"]]
        if args.due:
            due = resolve_due(args.due)
            tasks = [task for task in tasks if task["due"] is None] if due is None else [task for task in tasks if task["due"] and (task["due"] == due or task["due"].split("T", 1)[0] == due)]
        if args.priority:
            tasks = [task for task in tasks if task["priority"] == args.priority]
        names = {item["id"]: item["name"] for item in snapshot["lists"]}
        for task in tasks:
            mark = "✓" if task["completed"] else "·"
            print(f"{mark} {task['id']:<42} {task['title']}  [{names.get(task['listId'], '?')}]  {task['due'] or '-'}  {task['priority']}")
    else:
        request(f"/api/tasks/{args.task_id}", "PATCH", {"completed": True})
        print("완료 처리했습니다.")


if __name__ == "__main__":
    try:
        main()
    except ApiError as error:
        raise SystemExit(f"오류: {error}") from error
