# Assembles the mock as one page, the way it runs in Home Assistant: the fake HA and the panel's host element on the page,
# and the UI as the host's sandboxed frame. The frame gets the no-network CSP the real panel ships with, locked to its
# one script by hash, so a script that wasn't built in can't run.
# Usage: python3 build-mock.py <design dir> <ui.html> <seed.js> <out.html>
import base64, hashlib, json, re, sys

root, ui_file, seed_file, out_file = sys.argv[1:5]
read = lambda name: open(name if name.startswith("/") else f"{root}/{name}", encoding="utf-8").read()

ui = read(ui_file)
scripts = re.findall(r"<script>(.*?)</script>", ui, flags=re.S)
if len(scripts) != 1:
    sys.exit(f"the UI must have exactly one script, found {len(scripts)}")
digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode()
# The frame can't reach the network, so Roboto is built in rather than fetched (frontend/fonts/OFL.txt), as the real bundle must.
ui = re.sub(r'<link rel="(preconnect|stylesheet)" href="https://fonts\.[^"]*"[^>]*>\n?', "", ui)
font = base64.b64encode(open(f"{root}/../frontend/fonts/roboto-latin.woff2", "rb").read()).decode()
ui = f'<style>@font-face{{font-family:Roboto;src:url(data:font/woff2;base64,{font}) format("woff2");font-weight:100 900;font-display:block}}</style>' + ui
csp = f"default-src 'none'; script-src 'sha256-{digest}'; style-src 'unsafe-inline'; font-src data:"
frame = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{csp}">'
         f'<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>{ui}</body></html>')

def inline(js):
    if "</script" in js.lower():
        sys.exit("a script contains </script")
    return js

as_js = json.dumps(frame, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")
page = read("dev-shell.html")
for marker, body in (("/*SEED*/", read(seed_file)), ("/*FAKE_HA*/", read("fake-ha.js")), ("/*HOST*/", read("host.js")),
                     ("/*UI*/", f'"use strict";\nconst UI_HTML = {as_js};\n')):
    if page.count(marker) != 1:
        sys.exit(f"dev-shell.html needs one {marker}")
    page = page.replace(marker, inline(body))
open(out_file if out_file.startswith("/") else f"{root}/{out_file}", "w", encoding="utf-8").write(page)
print(f"built {out_file}, {len(page) // 1024} KB")
