"""Drive the interactive CLI in a real pseudo-terminal. Reads a JSON script on stdin:
{"argv": [...], "cwd": "...", "steps": [{"expect": "text"} | {"send": "keys"} | {"sleep": 0.2}]}
Prints JSON: {"ok": bool, "failed": step or null, "screen": plain text, "exit": code}."""
import fcntl, json, os, pty, re, select, struct, sys, termios, time

job = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(job["cwd"])
    os.execvp(job["argv"][0], job["argv"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
raw = b""
seen = 0
ANSI = re.compile(r"\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.")


def screen():
    return ANSI.sub("", raw.decode("utf-8", "replace")).replace("\r", "")


def pump(wait):
    global raw
    ready, _, _ = select.select([fd], [], [], wait)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        raw += data
    return True


failed = None
for step in job["steps"]:
    if "expect" in step:
        end = time.time() + step.get("timeout", 20)
        while True:
            at = screen().find(step["expect"], seen)
            if at >= 0:
                seen = at + len(step["expect"])
                break
            if time.time() > end or not pump(0.1):
                failed = step
                break
        if failed:
            break
    elif "send" in step:
        time.sleep(0.15)
        os.write(fd, step["send"].encode())
    else:
        end = time.time() + step["sleep"]
        while time.time() < end:
            pump(0.05)

code = None
end = time.time() + 10
while time.time() < end:
    pump(0.1)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(status)
        break
if code is None:
    os.kill(pid, 9)
print(json.dumps({"ok": failed is None, "failed": failed, "screen": screen(), "exit": code}))
