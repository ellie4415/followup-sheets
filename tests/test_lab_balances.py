"""/lab-balances, using the real shapes from the Nov 4 2026 test tickets.

    python tests/test_lab_balances.py      (needs requirements installed)
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main   # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def line(line_id, sale, customer, layaway, total, created="2026-11-04T22:26:11+00:00", qty="1"):
    return {"saleLineID": line_id, "saleID": sale, "customerID": customer, "isLayaway": layaway,
            "calcTotal": total, "unitQuantity": qty, "createTime": created, "itemID": "16890"}


def ticket(sale, completed="true", total="0", due="0", voided="false", at="2026-11-04T22:28:00+00:00"):
    return {"saleID": sale, "customerID": "5119", "completed": completed, "voided": voided,
            "calcTotal": total, "totalDue": due, "createTime": at}


PAID = [{"amount": "-5", "creditAccountID": "1311"}, {"amount": "5", "creditAccountID": "0"}]


class Fake:
    def __init__(self):
        self.calls = []

    async def get(self, path, params=None):
        self.calls.append(path)
        if path == "SaleLine.json":
            if params["itemID"] == "16891":
                return {"SaleLine": line("172025", "0", "5119", "true", "1.0725")}
            return {"SaleLine": [line("172022", "0", "5119", "true", "5"),
                                 line("172026", "0", "5119", "true", "10"),
                                 line("900", "108500", "0", "false", "7"),
                                 line("901", "108501", "0", "false", "8"),
                                 line("902", "0", "4444", "true", "9"),
                                 line("903", "108479", "5119", "true", "10"),    # completed layaway
                                 line("904", "108481", "5119", "true", "11")]}   # being completed
        if path == "Sale.json":
            return {"Sale": [ticket("108481", completed="false", total="11"),
                             ticket("108479", total="10", due="10"),
                             ticket("108500", total="7"),            # plain sale, finished
                             ticket("108501", completed="false"),    # plain sale, still a cart
                             ticket("108473", completed="false"),    # unfinished layaway
                             ticket("108470"),                       # finished layaway, unpaid
                             ticket("108468", due="5"),              # the payment
                             ticket("108400", due="5", voided="true")]}
        if path.startswith("Sale/"):
            sale_id = path[5:-5]
            return {"Sale": {"saleID": sale_id, "customerID": "0" if sale_id == "1" else "5119"}}
        raise AssertionError(path)

    async def get_sale_payments(self, sale_id):
        self.calls.append("payments " + sale_id)
        return PAID


fake = Fake()


async def fake_client():
    return fake


main.get_client = fake_client
out = asyncio.run(main.lab_balances("108286, 108300,1,abc"))
check("answers", out["ok"] is True)
act = out["sales"]["108286"]
check("same customer shares one answer", out["sales"]["108300"] == act and
      fake.calls.count("Sale.json") == 1)
check("no customer on the sale: nothing", out["sales"]["1"] == {"lines": [], "deposits": []})
check("junk sale IDs are skipped", "abc" not in out["sales"])

ids = {l["line"]: l for l in act["lines"]}
check("layaway lines found, finished or not", {"172022", "172025", "172026"} <= set(ids))
check("layaway line is a layaway", ids["172022"]["layaway"] and not ids["172022"]["sold"])
check("line on a finished ticket is sold", ids["900"]["sold"] and ids["900"]["ticket"] == "108500")
check("line on an open cart doesn't count", "901" not in ids)
check("completed layaway is sold, though it keeps its layaway flag",
      ids["903"]["sold"] and not ids["903"]["layaway"] and ids["903"]["ticket"] == "108479")
check("layaway on a ticket not finished yet is still a layaway",
      ids["904"]["layaway"] and not ids["904"]["sold"])
check("someone else's layaway doesn't count", "902" not in ids)
check("the deposit", act["deposits"] == [{"ticket": "108468", "amount": 5.0,
                                          "at": "2026-11-04T22:28:00+00:00"}], act["deposits"])
check("only the deposit ticket's payments were read",
      [c for c in fake.calls if c.startswith("payments")] == ["payments 108468"])

# A second read uses what it already knows
fake.calls.clear()
asyncio.run(main.lab_balances("108286"))
check("no repeat lookups", not [c for c in fake.calls if c.startswith(("payments", "Sale/"))], fake.calls)

# Deposits
sale = ticket("1", due="5")
check("card in, account out: deposit", main._deposit(sale, PAID)["amount"] == 5.0)
check("no money in: not a deposit", main._deposit(sale, []) is None)
check("account only: not a deposit", main._deposit(sale, PAID[:1]) is None)
check("money in, nothing to the account: not a deposit", main._deposit(sale, PAID[1:]) is None)
check("amounts differ: not a deposit", main._deposit(
    sale, [{"amount": "-5", "creditAccountID": "1311"}, {"amount": "4", "creditAccountID": "0"}]) is None)
check("unvoided finished $0 with money due is a candidate", main._maybe_deposit(ticket("1", due="5")))
check("nothing due isn't", not main._maybe_deposit(ticket("1")))
check("voided isn't", not main._maybe_deposit(ticket("1", due="5", voided="true")))
check("a normal sale isn't", not main._maybe_deposit(ticket("1", total="5", due="5")))

print()
print("ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
