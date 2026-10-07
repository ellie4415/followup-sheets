"""Offline tests for the Mack output (fake Lightspeed + fake sheets, no network).

Run from the repo root with the app's requirements installed:
    python tests/test_mack.py
"""
import asyncio, os, sys, tempfile, json

os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["LIGHTSPEED_CLIENT_ID"] = "x"
os.environ["SHEETS_WEBAPP_URL"] = "https://script.google.com/macros/s/x/exec"
os.environ["SHEETS_SECRET"] = "s"
os.environ["MACK_WEBAPP_URL"] = "https://script.google.com/macros/s/mack/exec"
os.environ["MACK_SECRET"] = "mack-secret"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
os.chdir(REPO)

import main, mack as mk, store, lightspeed as ls

store.init()

CATS = [{"categoryID": "1", "name": "Cameras", "parentID": "0"},
        {"categoryID": "2", "name": "Lenses", "parentID": "0"},
        {"categoryID": "3", "name": "Warranties", "parentID": "0"},
        {"categoryID": "4", "name": "Accessories", "parentID": "0"}]

def line(lid, desc, qty, sub, cat="1", emp="7", disc=0, parent=None, mid="11", price=None):
    d = {"saleLineID": str(lid), "itemDescription": desc, "unitQuantity": str(qty),
         "calcSubtotal": str(sub), "calcLineDiscount": str(disc), "employeeID": emp,
         "avgCost": "1", "Item": {"categoryID": cat, "description": desc, "manufacturerID": mid,
                                  "Prices": {"ItemPrice": [{"amount": str(price or abs(sub) / abs(qty)), "useType": "Default"}]}}}
    if parent: d["parentSaleLineID"] = str(parent)
    return d

CUST = {"customerID": "55", "firstName": "Pat", "lastName": "Test", "company": "",
        "Contact": {"Emails": {"ContactEmail": {"address": "pat@example.com"}},
                    "Phones": {"ContactPhone": [{"number": "9165551234", "useType": "Mobile"}]},
                    "Addresses": {"ContactAddress": {"address1": "1 Main St", "address2": "", "city": "Rocklin",
                                                     "state": "CA", "zip": "95765"}}}}

def sale(sid, lines, shop="1", total=None, cust="55", completed="true"):
    s = {"saleID": str(sid), "completed": completed, "voided": "false", "shopID": shop,
         "customerID": cust, "employeeID": "7", "timeStamp": "2026-10-06T19:00:00+00:00",
         "completeTime": "2026-10-06T19:00:00+00:00",
         "calcTotal": str(total if total is not None else sum(float(l["calcSubtotal"]) for l in lines)),
         "SaleLines": {"SaleLine": lines}}
    if cust != "0": s["Customer"] = CUST
    return s

SALES = [
    # camera kit + Mack x1
    sale(101, [line(1, "Canon EOS R7 Kit w/ 18-150mm", 1, 1899.0), line(2, "Mack 3 Yr Under $2000 Diamond OL", 1, 239.95, cat="3")]),
    # two warranties on one receipt (qty 2)
    sale(102, [line(3, "Mack 3 Yr Under $1000 Diamond OL", 2, 299.90, cat="3")]),
    # return of the first warranty + new one (exchange of warranties)
    sale(103, [line(4, "Mack 3 Yr Under $2000 Diamond OL", -1, -239.95, cat="3", parent=2),
               line(5, "Mack 3 Yr Under $2500 Diamond OL", 1, 279.95, cat="3")], total=40),
    # online shop, walk-in, mack
    sale(104, [line(6, "Mack 3 Yr Under $500 Diamond OL", 1, 69.95, cat="3")], shop="9", cust="0"),
    # nothing mack
    sale(105, [line(7, "Sony A7 IV", 1, 2499.0)]),
]

class FakeClient(ls.LightspeedClient):
    def __init__(self): super().__init__("tok", "304409")
    async def get_categories(self): return CATS
    async def get_shops(self): return {"1": "Rocklin", "2": "Reno", "9": "Action Camera Online"}
    async def get_employees(self): return {"7": "Alison Watkins"}
    async def get_customer(self, cid): return CUST
    async def get_sale_lines(self, sid):
        for s in SALES:
            if s["saleID"] == str(sid): return s["SaleLines"]["SaleLine"]
        return []
    async def get_url(self, url, params=None): raise AssertionError("no paging expected")
    async def get(self, path, params=None):
        if path == "Sale.json" and params and params.get("sort") == "-saleID":
            return {"Sale": list(reversed(SALES)), "@attributes": {}}
        if path == "Sale.json" and params and "ticketNumber" in params:
            return {}
        if path.startswith("Sale/"):
            sid = path.split("/")[1].split(".")[0]
            return {"Sale": next((s for s in SALES if s["saleID"] == sid), {})}
        if path.startswith("Manufacturer/"):
            return {"Manufacturer": {"manufacturerID": "11", "name": "Canon"}}
        if path == "Serialized.json":
            return {"Serialized": {"serial": "SN-" + params["saleLineID"]}} if params["saleLineID"] == "1" else {}
        raise AssertionError(f"unexpected GET {path} {params}")

class FakeSheets:
    def __init__(self): self.appends = []
    async def ensure_setup(self): pass
    async def read_settings(self):
        return {"threshold": 300, "categories": ["Cameras", "Lenses"], "excluded": ["Warranties"],
                "skip_shops": ["action camera online"]}
    async def existing_sale_ids(self, tab): return set()
    async def append_rows(self, tab, rows): self.appends.append((tab, rows))
    def supports_dynamic_tabs(self): return True
    def script_version(self): return 9

posted = []
async def fake_bridge_ok(body):
    posted.append(body); return {"ok": True, "added": len(body["units"])}
async def fake_bridge_fail(body):
    raise RuntimeError("Mack sheet down")

fs = FakeSheets()
async def fake_get_client(): return FakeClient()
main.get_client = fake_get_client
main._make_sheets = lambda: fs
main._make_manager_sheets = lambda: None

def run(coro): return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)

# ── 1. A run with the Mack sheet DOWN: follow-up rows still land, cursor advances, units queued
store.set("cursor", "100")
mk._bridge_post = fake_bridge_fail
s1 = run(main.run_job("test"))
assert s1["ok"], s1
assert store.get("cursor") == "105", store.get("cursor")
fu_ids = [r[-1] for tab, rows in fs.appends for r in rows]
assert "101" in fu_ids, fu_ids
assert any("Mack sheet down" in w for w in s1.get("warnings", [])), s1
box = store.get_json(mk.OUTBOX_KEY)
keys = [u["key"] for u in box]
assert keys == ["2-1", "3-1", "3-2", "R4-1", "5-1", "6-1"], keys
ret = next(u for u in box if u["key"] == "R4-1")
assert ret["qty"] == -1 and ret["reverses"] == "2", ret
assert next(u for u in box if u["key"] == "6-1")["store"] == "Action Camera Online"
assert next(u for u in box if u["key"] == "3-2")["price"] == 149.95
print("run with Mack down: OK  (follow-up rows:", fu_ids, ") queued:", keys)

# ── 2. Next run with the sheet UP sends the queue even with no new sales
mk._bridge_post = fake_bridge_ok
s2 = run(main.run_job("test"))
assert s2["ok"] and s2["added"].get("Mack warranties") == 6, s2
assert store.get_json(mk.OUTBOX_KEY) == []
print("retry run sent queued units: OK", s2["added"])

# ── 3. Mack disabled: run identical to before (no Mack keys anywhere)
mk.MACK_WEBAPP_URL = ""
store.set("cursor", "100"); fs.appends.clear(); posted.clear()
s3 = run(main.run_job("test"))
assert s3["ok"] and "Mack warranties" not in s3["added"] and not posted and not store.get_json(mk.OUTBOX_KEY)
print("Mack disabled: OK")
mk.MACK_WEBAPP_URL = "https://script.google.com/macros/s/mack/exec"

# ── 4. The review bundle for receipt 101
ctx = {"shops": {"1": "Rocklin"}, "employees": {"7": "Alison Watkins"}, "categories": CATS,
       "qual_ids": {"1", "2"}, "min_camera_price": 100}
b = run(mk.sale_bundle(FakeClient(), "101", ctx))
assert b["sale_id"] == "101" and b["store"] == "Rocklin" and b["date"] == "10-06-2026", b
assert b["customer"]["zip"] == "95765" and b["customer"]["email"] == "pat@example.com"
cam = b["lines"][0]; war = b["lines"][1]
assert cam["brand"] == "Canon" and cam["model"] == "EOS R7 Kit w/ 18-150mm" and cam["serials"] == ["SN-1"], cam
assert cam["camera_or_lens"] and not cam["is_mack"]
assert war["is_mack"] and war["plan"] == {"years": 3, "coverage": 2000, "condition": "New"} and war["serials"] == []
print("bundle: OK", json.dumps(cam))

# ── 5. parsers
assert mk.parse_plan("Mack 1 Yr Used Photo Under $1,000 OL") == {"years": 1, "coverage": 1000, "condition": "Used"}
assert mk.is_mack("MACK 5 Yr Under $750")
assert not mk.is_mack("Mackie speaker") and not mk.is_mack("Camera bag (Mack)")
assert mk.unit_price({"unitQuantity": "1", "calcSubtotal": "1999", "calcLineDiscount": "200"}) == 1799.0
assert mk.unit_price({"unitQuantity": "-1", "calcSubtotal": "-239.95", "calcLineDiscount": "0"}) == 239.95
print("parsers: OK")

# ── 6. endpoint auth
from fastapi.testclient import TestClient
tc = TestClient(main.app)
main._mack_context = lambda client: asyncio.sleep(0, result=ctx)
assert tc.get("/mack/sale/101").status_code == 403
assert tc.get("/mack/sale/101", headers={"X-Mack-Secret": "wrong"}).status_code == 403
r = tc.get("/mack/sale/101", headers={"X-Mack-Secret": "mack-secret"})
assert r.status_code == 200 and r.json()["sale_id"] == "101", r.text
assert tc.get("/mack/sale/abc", headers={"X-Mack-Secret": "mack-secret"}).status_code == 400
r = tc.get("/mack/preview?days=3"); assert r.status_code == 200 and r.json()["count"] == 6 and "customer" not in r.json()["units"][0], r.text
print("endpoints: OK")
print("ALL SERVER TESTS PASSED")
