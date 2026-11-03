"""Run the local server in the calling console, with readable port diagnostics."""

import argparse
import socket
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def show_port_owner(port: int) -> None:
    # Only the validated integer is interpolated; process text is output, never executed.
    command = (
        "$ErrorActionPreference = 'Stop'; "
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
        f"Get-NetTCPConnection -State Listen -LocalPort {port} | "
        "Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { "
        "$owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_); "
        "Write-Output ('PID: ' + $_); "
        "Write-Output ('程序: ' + $owner.Name); "
        "Write-Output ('启动命令: ' + $owner.CommandLine) }"
    )
    try:
        owner_query = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", command],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        print("未能读取占用进程详情，请在任务管理器中查看。", flush=True)
        return
    print(owner_query.stdout.strip() or "未找到监听进程，端口可能被系统保留。", flush=True)


def valid_port(text: str) -> int:
    try:
        port = int(text)
    except ValueError as error:
        raise argparse.ArgumentTypeError("端口必须是 1 到 65535 的整数") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须是 1 到 65535 的整数")
    return port


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=valid_port, default=8741, metavar="PORT")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    try:
        with socket.socket() as probe:
            if sys.platform == "win32":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", args.port))
    except OSError as error:
        print(f"无法启动：端口 {args.port} 已被占用或不可用。\n{error}", flush=True)
        if sys.platform == "win32":
            show_port_owner(args.port)
        print(f"如果是已启动的知识地图，可打开 {url}。", flush=True)
        print("需要改用其他端口时，运行 start.cmd --port 8742。", flush=True)
        return 1

    print(f"知识地图：{url}", flush=True)
    print("此窗口显示实时日志。保留窗口，按 Ctrl+C 停止服务。", flush=True)
    try:
        return subprocess.call(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "backend.app:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(args.port),
            ],
            cwd=PROJECT_ROOT,
        )
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
